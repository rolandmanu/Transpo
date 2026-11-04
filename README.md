# TOBIS production foundation — native app + Firebase + WhatsApp

This repository contains the Expo Android/iOS client and a Firebase Functions backend. It is **not production-live until the project owner completes the provider setup, provisions users, supplies verified route/stop data, and runs device/security tests**. Never put WhatsApp access tokens or Firebase Admin credentials in this repository.

## Production flow

1. Approved driver (Firebase Auth account with custom claim `driver: true`) starts a trip through `startDriverTrip` and sends GPS updates through `publishDriverLocation`.
2. Passenger enters a WhatsApp number, selects a published route/stop, and explicitly opts in. `requestPassengerSubscription` sends a one-time verification code using a WhatsApp template. Notifications start only after `verifyPassengerSubscription` succeeds.
3. Scheduled `sendPassengerUpdates` checks due verified subscriptions, finds the nearest active bus on that route, calculates a rough ETA from route stop coordinates and configured average speed, and sends an approved WhatsApp template about every two minutes (about every minute for ETA <= 3 minutes).
4. Passenger can unsubscribe using their per-subscription token. Phone numbers and tokens are backend-only Firestore data; clients cannot read the private collection.

The ETA is a straight-line distance / configured average-speed estimate, not traffic-aware routing. Do not describe it as guaranteed. Better ETA needs route geometry, direction and/or a routing/traffic provider.

## Firebase setup / deploy

1. Create a Firebase project, enable Authentication, Firestore, Functions, App Check and billing/Blaze (scheduled functions and external API calls need billing).
2. Add the native app to Firebase and configure the platform Firebase app credentials and identifiers in the Expo/EAS build environment. The current native screen still needs client Firebase Auth/Functions wiring; backend endpoints reject unauthenticated drivers and unverified callers. Do not deploy expecting the current local-demo screen to publish remotely until that client integration is completed.
3. In WhatsApp Business Platform, verify the business/phone number, obtain approval for two French templates: `tobis_verification` (one body variable: code) and `tobis_bus_update` (four body variables: route, stop, ETA, local update time). Exact template names/language must match Meta approval.
4. Store provider credentials as Firebase secret parameters, never in source:

```sh
firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN
firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
firebase functions:secrets:set WHATSAPP_VERIFY_TEMPLATE
firebase functions:secrets:set WHATSAPP_UPDATE_TEMPLATE
firebase functions:secrets:set WHATSAPP_APP_SECRET
```

`WHATSAPP_APP_SECRET` must be a long random secret used to hash short-lived verification codes. Restrict its access to the relevant functions. Add App Check enforcement provider configuration for the app before allowing production traffic.

5. Configure Firebase CLI project alias, install/build functions, then deploy:

```sh
firebase use --add
cd functions && npm install && npm run build && cd ..
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Hosting on GitHub Pages does not deploy Cloud Functions. Hosting the native app build and backend are separate deployments.

## Route data schema

Create admin-owned `routes/{lineId}` documents. Example (coordinates are placeholders; replace with verified operator data):

```json
{
  "enabled": true,
  "name": "L1 Tanger",
  "estimatedSpeedKmh": 20,
  "stops": [
    { "id": "stop-1", "name": "Verified stop name", "lat": 35.0, "lng": -5.0 }
  ]
}
```

Never deploy invented stop coordinates. The existing `data/tobis-l1-demo.json` explicitly says OSM route/stop data retrieval was blocked and geometry is empty.

## Driver and admin provisioning

Driver and admin identity is controlled by Firebase custom claims. Create/authenticate users using a trusted admin process and assign claims from a private Admin SDK environment. The `setDriverRole` callable is restricted to users with an already provisioned `admin: true` claim; bootstrap the first admin out of band. Do not create a public driver PIN or let clients edit their own role.

## Privacy and operations checklist before pilot

- Obtain documented driver and passenger consent; publish privacy/retention terms and a deletion contact.
- Minimize location precision/update cadence and expire ended trips/subscriptions using a scheduled cleanup policy.
- Define how a passenger verifies, unsubscribes and handles lost access; test WhatsApp STOP handling before public launch.
- Restrict public live location exposure if the product does not require the map; the current rules allow reading active live trips.
- Set budget alerts, rate limits, App Check, abuse monitoring, crash reporting and a support contact.
- Test WhatsApp templates, phone formats (+country code), delivery failures, duplicate scheduler invocations, GPS denial/background behavior, poor connectivity and Android/iOS builds.
- Use a routing/traffic provider or validated route geometry for dependable ETAs. Current calculation is approximate.

## Honest current status

The production backend endpoints, opt-in verification, server-side WhatsApp sending, scheduler, indexes and restrictive PII rules are prepared here. The app UI in `app/index.tsx` is still a local prototype and does not yet call these endpoints; WhatsApp messages will not send until the native client integration, Firebase project, templates, route data and secrets are configured and deployed. A deployable foundation is not the same as a live transit service.
