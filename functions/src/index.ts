import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { createHash, createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 4 });

const db = getFirestore();
const WA_TOKEN = defineSecret('WHATSAPP_ACCESS_TOKEN');
const WA_PHONE_NUMBER_ID = defineSecret('WHATSAPP_PHONE_NUMBER_ID');
const WA_VERIFY_TEMPLATE = defineSecret('WHATSAPP_VERIFY_TEMPLATE');
const WA_UPDATE_TEMPLATE = defineSecret('WHATSAPP_UPDATE_TEMPLATE');
const WA_APP_SECRET = defineSecret('WHATSAPP_APP_SECRET');
const GRAPH_VERSION = 'v21.0';
const PRIVATE_SUBSCRIPTIONS = 'passengerSubscriptions';
const ACTIVE_TRIPS = 'liveTrips';
const MAX_CODE_AGE_MS = 10 * 60 * 1000;
const MIN_PHONE_INTERVAL_MS = 60 * 1000;

function requireAppCheck(request: { app?: unknown }) {
  if (!request.app) throw new HttpsError('failed-precondition', 'App Check is required.');
}
function requireDriver(request: { auth?: { uid: string; token: Record<string, unknown> } | undefined }) {
  if (!request.auth || request.auth.token.driver !== true) throw new HttpsError('permission-denied', 'An approved driver account is required.');
  return request.auth.uid;
}
function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}
function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : '';
}
function phoneHash(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}
function codeDigest(subscriptionId: string, code: string): string {
  return createHmac('sha256', WA_APP_SECRET.value()).update(`${subscriptionId}:${code}`).digest('hex');
}
function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radians = (n: number) => n * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
async function sendWhatsAppTemplate(phone: string, templateName: string, parameters: string[]) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID.value()}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'fr' },
        components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text: text.slice(0, 100) })) }]
      }
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error('WhatsApp API error', response.status, detail.slice(0, 1000));
    throw new Error(`WhatsApp API returned ${response.status}`);
  }
}

/** A driver must be provisioned by an administrator and have the Firebase custom claim {driver:true}. */
export const startDriverTrip = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireDriver(request);
  const city = cleanString(request.data?.city, 50);
  const lineId = cleanString(request.data?.lineId, 60);
  const vehicle = cleanString(request.data?.vehicle, 40);
  if (!city || !lineId || !vehicle) throw new HttpsError('invalid-argument', 'City, lineId and vehicle are required.');

  const route = await db.doc(`routes/${lineId}`).get();
  if (!route.exists || route.data()?.enabled !== true) throw new HttpsError('failed-precondition', 'This route is not enabled.');
  const ref = await db.collection(ACTIVE_TRIPS).add({
    driverUid: uid,
    city,
    lineId,
    lineName: cleanString(route.data()?.name, 80),
    vehicle,
    status: 'active',
    location: null,
    startedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  return { tripId: ref.id };
});

/** Publishes a single validated location point for the authenticated trip owner. */
export const publishDriverLocation = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireDriver(request);
  const tripId = cleanString(request.data?.tripId, 128);
  const lat = Number(request.data?.lat);
  const lng = Number(request.data?.lng);
  const accuracy = Number(request.data?.accuracy);
  if (!tripId || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000) {
    throw new HttpsError('invalid-argument', 'A valid trip ID and GPS point are required.');
  }
  const ref = db.doc(`${ACTIVE_TRIPS}/${tripId}`);
  await db.runTransaction(async (transaction) => {
    const trip = await transaction.get(ref);
    if (!trip.exists || trip.data()?.driverUid !== uid || trip.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Trip is not active or not owned by this driver.');
    transaction.update(ref, { location: { lat, lng, accuracy, capturedAt: Timestamp.now() }, updatedAt: FieldValue.serverTimestamp() });
  });
  return { accepted: true };
});

export const endDriverTrip = onCall({ enforceAppCheck: true }, async (request) => {
  const uid = requireDriver(request);
  const tripId = cleanString(request.data?.tripId, 128);
  if (!tripId) throw new HttpsError('invalid-argument', 'Trip ID is required.');
  const ref = db.doc(`${ACTIVE_TRIPS}/${tripId}`);
  await db.runTransaction(async (transaction) => {
    const trip = await transaction.get(ref);
    if (!trip.exists || trip.data()?.driverUid !== uid || trip.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Trip is not active or not owned by this driver.');
    transaction.update(ref, { status: 'ended', endedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return { ended: true };
});

/** Starts WhatsApp opt-in verification. No subscription messages are sent until the user verifies the code. */
export const requestPassengerSubscription = onCall({ enforceAppCheck: true, secrets: [WA_TOKEN, WA_PHONE_NUMBER_ID, WA_VERIFY_TEMPLATE, WA_APP_SECRET] }, async (request) => {
  const phone = normalizePhone(request.data?.phone);
  const lineId = cleanString(request.data?.lineId, 60);
  const stopId = cleanString(request.data?.stopId, 60);
  if (!phone || !lineId || !stopId || request.data?.consent !== true) throw new HttpsError('invalid-argument', 'Valid phone, route, stop, and explicit consent are required.');

  const routeRef = db.doc(`routes/${lineId}`);
  const route = await routeRef.get();
  const stop = (route.data()?.stops as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === stopId);
  if (!route.exists || route.data()?.enabled !== true || !stop) throw new HttpsError('not-found', 'Route or stop is unavailable.');

  const hash = phoneHash(phone);
  const throttleRef = db.doc(`subscriptionThrottle/${hash}`);
  const throttle = await throttleRef.get();
  const lastRequest = Number(throttle.data()?.requestedAtMs ?? 0);
  if (Date.now() - lastRequest < MIN_PHONE_INTERVAL_MS) throw new HttpsError('resource-exhausted', 'Please wait before requesting another code.');
  await throttleRef.set({ requestedAtMs: Date.now(), expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000) });

  const code = String(randomInt(100000, 1000000));
  const unsubscribeToken = randomBytes(32).toString('hex');
  const ref = await db.collection(PRIVATE_SUBSCRIPTIONS).add({
    phone,
    phoneHash: hash,
    lineId,
    stopId,
    stopName: cleanString(stop.name, 80),
    status: 'pending',
    consentAt: FieldValue.serverTimestamp(),
    verificationDigest: codeDigest('pending', code),
    verificationExpiresAt: Timestamp.fromMillis(Date.now() + MAX_CODE_AGE_MS),
    verificationAttempts: 0,
    unsubscribeTokenHash: phoneHash(unsubscribeToken),
    nextSendAt: null,
    createdAt: FieldValue.serverTimestamp()
  });
  // Bind the OTP digest to the actual generated document ID before sending.
  await ref.update({ verificationDigest: codeDigest(ref.id, code) });
  await sendWhatsAppTemplate(phone, WA_VERIFY_TEMPLATE.value(), [code]);
  return { subscriptionId: ref.id, unsubscribeToken };
});

export const verifyPassengerSubscription = onCall({ enforceAppCheck: true, secrets: [WA_APP_SECRET] }, async (request) => {
  const subscriptionId = cleanString(request.data?.subscriptionId, 128);
  const code = cleanString(request.data?.code, 6);
  if (!subscriptionId || !/^\d{6}$/.test(code)) throw new HttpsError('invalid-argument', 'Subscription ID and six-digit code are required.');
  const ref = db.doc(`${PRIVATE_SUBSCRIPTIONS}/${subscriptionId}`);
  let verified = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data();
    if (!snapshot.exists || data?.status !== 'pending') throw new HttpsError('not-found', 'Pending subscription not found.');
    if ((data.verificationAttempts ?? 0) >= 5 || !(data.verificationExpiresAt instanceof Timestamp) || data.verificationExpiresAt.toMillis() < Date.now()) {
      transaction.update(ref, { status: 'expired', phone: FieldValue.delete() });
      throw new HttpsError('deadline-exceeded', 'Verification code expired.');
    }
    const candidate = codeDigest(subscriptionId, code);
    if (!secureEqual(candidate, String(data.verificationDigest))) {
      transaction.update(ref, { verificationAttempts: FieldValue.increment(1) });
      throw new HttpsError('permission-denied', 'Incorrect verification code.');
    }
    transaction.update(ref, { status: 'active', verifiedAt: FieldValue.serverTimestamp(), nextSendAt: Timestamp.now(), verificationDigest: FieldValue.delete(), verificationExpiresAt: FieldValue.delete() });
    verified = true;
  });
  return { verified };
});

export const unsubscribePassenger = onCall({ enforceAppCheck: true }, async (request) => {
  const subscriptionId = cleanString(request.data?.subscriptionId, 128);
  const token = cleanString(request.data?.unsubscribeToken, 128);
  if (!subscriptionId || !/^[a-f0-9]{64}$/.test(token)) throw new HttpsError('invalid-argument', 'A valid subscription and unsubscribe token are required.');
  const ref = db.doc(`${PRIVATE_SUBSCRIPTIONS}/${subscriptionId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const expected = String(snapshot.data()?.unsubscribeTokenHash ?? '');
    const supplied = phoneHash(token);
    if (!snapshot.exists || !secureEqual(expected, supplied)) throw new HttpsError('permission-denied', 'Invalid unsubscribe token.');
    transaction.update(ref, { status: 'unsubscribed', phone: FieldValue.delete(), unsubscribedAt: FieldValue.serverTimestamp() });
  });
  return { unsubscribed: true };
});

/** Sends approved WhatsApp templates at a bounded cadence; only verified, opted-in subscribers are eligible. */
export const sendPassengerUpdates = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Africa/Casablanca', maxInstances: 1, secrets: [WA_TOKEN, WA_PHONE_NUMBER_ID, WA_UPDATE_TEMPLATE] }, async () => {
  const now = Timestamp.now();
  const due = await db.collection(PRIVATE_SUBSCRIPTIONS).where('status', '==', 'active').where('nextSendAt', '<=', now).limit(100).get();
  for (const subscription of due.docs) {
    const data = subscription.data();
    const routeSnapshot = await db.doc(`routes/${data.lineId}`).get();
    const route = routeSnapshot.data();
    const stop = (route?.stops as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === data.stopId);
    if (!routeSnapshot.exists || route?.enabled !== true || !stop || !data.phone) {
      await subscription.ref.update({ status: 'paused', nextSendAt: null });
      continue;
    }
    const active = await db.collection(ACTIVE_TRIPS).where('lineId', '==', data.lineId).where('status', '==', 'active').limit(20).get();
    const stopLat = Number(stop.lat); const stopLng = Number(stop.lng);
    const candidates = active.docs.map((trip) => trip.data()).filter((trip) => trip.location && Number.isFinite(Number(trip.location.lat)) && Number.isFinite(Number(trip.location.lng)));
    if (!candidates.length || !Number.isFinite(stopLat) || !Number.isFinite(stopLng)) {
      await subscription.ref.update({ nextSendAt: Timestamp.fromMillis(Date.now() + 2 * 60 * 1000) });
      continue;
    }
    const closest = candidates.map((trip) => ({ trip, distance: haversineMeters({ lat: Number(trip.location.lat), lng: Number(trip.location.lng) }, { lat: stopLat, lng: stopLng }) })).sort((a, b) => a.distance - b.distance)[0];
    const speedKmh = Math.min(45, Math.max(8, Number(route?.estimatedSpeedKmh) || 20));
    const etaMinutes = Math.max(1, Math.ceil((closest.distance / 1000) / speedKmh * 60));
    const intervalMs = etaMinutes <= 3 ? 60_000 : 120_000;

    // Reserve this interval transactionally to avoid duplicate messages if the scheduler retries.
    const lease = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(subscription.ref);
      if (!current.exists || current.data()?.status !== 'active' || !(current.data()?.nextSendAt instanceof Timestamp) || current.data()!.nextSendAt.toMillis() > Date.now()) return false;
      transaction.update(subscription.ref, { nextSendAt: Timestamp.fromMillis(Date.now() + intervalMs), lastAttemptAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (!lease) continue;

    try {
      const displayLine = cleanString(route?.name, 80) || data.lineId;
      await sendWhatsAppTemplate(data.phone, WA_UPDATE_TEMPLATE.value(), [displayLine, cleanString(stop.name, 80), `${etaMinutes} min`, new Date().toLocaleTimeString('fr-MA', { timeZone: 'Africa/Casablanca', hour: '2-digit', minute: '2-digit' })]);
      await subscription.ref.update({ lastSentAt: FieldValue.serverTimestamp(), lastEtaMinutes: etaMinutes, failedAttempts: 0 });
    } catch (error) {
      console.error('Passenger WhatsApp update failed', subscription.id, error);
      await subscription.ref.update({ nextSendAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000), failedAttempts: FieldValue.increment(1) });
    }
  }
});

/** Administrative callable for assigning the driver claim. Bootstrap an admin claim manually with Firebase Admin SDK first. */
export const setDriverRole = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth || request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Administrator access is required.');
  const uid = cleanString(request.data?.uid, 128);
  const enabled = request.data?.enabled === true;
  if (!uid) throw new HttpsError('invalid-argument', 'User ID is required.');
  const user = await getAuth().getUser(uid);
  await getAuth().setCustomUserClaims(uid, { ...user.customClaims, driver: enabled });
  return { uid, driver: enabled };
});

/** Admin health check; never returns phone numbers or credentials. */
export const productionHealth = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth || request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Administrator access is required.');
  const [routes, trips, subscribers] = await Promise.all([
    db.collection('routes').where('enabled', '==', true).count().get(),
    db.collection(ACTIVE_TRIPS).where('status', '==', 'active').count().get(),
    db.collection(PRIVATE_SUBSCRIPTIONS).where('status', '==', 'active').count().get()
  ]);
  return { enabledRoutes: routes.data().count, activeTrips: trips.data().count, optedInSubscribers: subscribers.data().count, checkedAt: new Date().toISOString() };
});
