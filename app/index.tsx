import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import MapView, { Callout, Circle, Marker, Polyline, Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

type Screen = 'home' | 'map' | 'routes' | 'alerts' | 'settings' | 'driver';
type Coordinates = { latitude: number; longitude: number };
type LiveTrip = { line: string; vehicle: string; city: string; location: Coordinates; updatedAt: number; demo?: boolean };

const COLORS = { navy: '#082c56', blue: '#0867b2', blue2: '#0c4c84', gold: '#ffc400', mint: '#14c79a', bg: '#edf4fa', ink: '#10243a', muted: '#647a90', line: '#dce7f0', white: '#fff', red: '#d94a42' };
const TANGIER: Coordinates = { latitude: 35.7595, longitude: -5.834 };
const DEMO_TRIPS: LiveTrip[] = [
  { line: 'L1 · Démonstration', vehicle: 'ALSA-12-01', city: 'Tanger', location: { latitude: 35.7672, longitude: -5.8136 }, updatedAt: Date.now(), demo: true },
  { line: 'L2 · Démonstration', vehicle: 'TOBIS-02', city: 'Tanger', location: { latitude: 35.7518, longitude: -5.842 }, updatedAt: Date.now(), demo: true }
];
const ROUTE_STOPS = ['Gare routière (exemple)', 'Centre-ville (exemple)', 'Grand Socco (exemple)', 'Malabata (exemple)'];

export default function HomeScreen() {
  const [screen, setScreen] = useState<Screen>('home');
  const [driverMode, setDriverMode] = useState(false);
  const [trips, setTrips] = useState<LiveTrip[]>(DEMO_TRIPS);
  const [location, setLocation] = useState<Coordinates | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [tracking, setTracking] = useState(false);
  const [driverName, setDriverName] = useState('');
  const [vehicle, setVehicle] = useState('ALSA-12-01');
  const [line, setLine] = useState('L1');
  const [phone, setPhone] = useState('');
  const [selectedLine, setSelectedLine] = useState('L1');
  const [selectedStop, setSelectedStop] = useState(ROUTE_STOPS[1]);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState('GPS arrêté');
  const [loading, setLoading] = useState(false);
  const [lastAlert, setLastAlert] = useState('Aucune alerte programmée');
  const [mapRegion, setMapRegion] = useState<Region>({ ...TANGIER, latitudeDelta: 0.075, longitudeDelta: 0.075 });
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestTrip = useMemo(() => trips.find((trip) => !trip.demo) ?? trips[0], [trips]);

  useEffect(() => {
    AsyncStorage.multiGet(['tobis.phone', 'tobis.line', 'tobis.stop']).then((items) => {
      const saved = Object.fromEntries(items);
      if (saved['tobis.phone']) setPhone(saved['tobis.phone']!);
      if (saved['tobis.line']) setSelectedLine(saved['tobis.line']!);
      if (saved['tobis.stop']) setSelectedStop(saved['tobis.stop']!);
    }).catch(() => undefined);
    return () => {
      watcher.current?.remove();
      if (demoTimer.current) clearInterval(demoTimer.current);
    };
  }, []);

  async function getMyLocation() {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setPermission('Autorisation GPS refusée'); Alert.alert('Localisation', 'Autorisez la localisation dans les réglages pour afficher votre position.'); return; }
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const point = { latitude: current.coords.latitude, longitude: current.coords.longitude };
      setLocation(point); setAccuracy(Math.round(current.coords.accuracy ?? 0));
      setMapRegion({ ...point, latitudeDelta: 0.025, longitudeDelta: 0.025 }); setPermission('Position trouvée');
    } catch (error) { setPermission('Position indisponible'); Alert.alert('GPS', 'Impossible de déterminer votre position. Vérifiez le GPS et réessayez.'); }
    finally { setLoading(false); }
  }

  async function startDriverTrip() {
    if (!vehicle.trim() || !line.trim()) { Alert.alert('Informations requises', 'Renseignez le numéro du véhicule et la ligne.'); return; }
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') { Alert.alert('GPS requis', 'Autorisez la localisation pour partager le trajet.'); return; }
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' as const }));
    if (Platform.OS === 'android' && bg.status !== 'granted') Alert.alert('GPS en arrière-plan', 'Le suivi peut s’arrêter lorsque l’application est fermée. Gardez TOBIS ouverte pendant le trajet.');
    setTracking(true); setDriverMode(true); setScreen('driver'); setPermission('Recherche GPS…');
    watcher.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 15 }, (position) => {
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setLocation(point); setAccuracy(Math.round(position.coords.accuracy ?? 0)); setPermission('GPS chauffeur actif');
      setMapRegion({ ...point, latitudeDelta: 0.018, longitudeDelta: 0.018 });
      setTrips((current) => [{ line: `${line} · ${driverName || 'Chauffeur'}`, vehicle, city: 'Tanger', location: point, updatedAt: Date.now() }, ...current.filter((trip) => trip.demo)]);
    });
    setLastAlert('Position locale mise à jour · serveur non connecté');
  }

  function stopDriverTrip() {
    watcher.current?.remove(); watcher.current = null; setTracking(false); setPermission('Trajet terminé');
    setTrips((current) => current.filter((trip) => trip.demo));
  }

  async function demoVehicle() {
    if (demoTimer.current) clearInterval(demoTimer.current);
    setScreen('map');
    let index = 0;
    const points = [TANGIER, { latitude: 35.7642, longitude: -5.827 }, { latitude: 35.761, longitude: -5.821 }, { latitude: 35.758, longitude: -5.817 }];
    const move = () => {
      const point = points[index++ % points.length];
      const demo: LiveTrip = { line: 'L1 · Démonstration', vehicle: 'ALSA-12-01', city: 'Tanger', location: point, updatedAt: Date.now(), demo: true };
      setTrips((current) => [demo, ...current.filter((trip) => trip.vehicle !== demo.vehicle && trip.vehicle !== 'TOBIS-02')]);
      setMapRegion({ ...point, latitudeDelta: 0.035, longitudeDelta: 0.035 });
    };
    move(); demoTimer.current = setInterval(move, 7000);
  }

  async function subscribeAlerts() {
    const normalized = phone.replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{7,14}$/.test(normalized)) { Alert.alert('Numéro WhatsApp', 'Entrez un numéro international valide, par exemple +212612345678.'); return; }
    try {
      await AsyncStorage.multiSet([['tobis.phone', normalized], ['tobis.line', selectedLine], ['tobis.stop', selectedStop]]);
      setPhone(normalized); setSubscribed(true);
      const permissionResult = await Notifications.requestPermissionsAsync();
      if (permissionResult.granted) {
        await Notifications.scheduleNotificationAsync({ content: { title: 'TOBIS · Alertes activées', body: `${selectedLine} — ${selectedStop}. Les alertes locales sont une démonstration; aucune position distante n’est encore reliée.`, sound: true }, trigger: null });
        setLastAlert('Alerte test envoyée sur cet appareil');
      }
      Alert.alert('Préférences enregistrées', 'Ce téléphone a enregistré la ligne et l’arrêt. Les messages WhatsApp distants nécessitent encore un backend sécurisé.');
    } catch { Alert.alert('Erreur', 'Impossible d’enregistrer vos préférences sur cet appareil.'); }
  }

  async function stopAlerts() {
    await AsyncStorage.multiRemove(['tobis.phone', 'tobis.line', 'tobis.stop']); setSubscribed(false); setPhone('');
    Alert.alert('Alertes arrêtées', 'Les préférences locales ont été supprimées. Les abonnements WhatsApp serveur nécessiteront aussi une désinscription côté backend.');
  }

  async function shareWhatsApp() {
    if (!phone) { Alert.alert('WhatsApp', 'Renseignez d’abord le numéro du passager.'); return; }
    const text = `TOBIS · ${selectedLine} à Tanger. Position connue: ${latestTrip?.location.latitude.toFixed(5)}, ${latestTrip?.location.longitude.toFixed(5)}. Cette démo ne fournit pas un ETA officiel.`;
    const url = `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
    const supported = await Linking.canOpenURL(url);
    if (supported) await Linking.openURL(url); else Alert.alert('WhatsApp', 'Installez WhatsApp pour continuer.');
  }

  function navigate(next: Screen) { setScreen(next); }
  function titleForScreen() { return ({ home: 'الرئيسية', map: 'الخريطة المباشرة', routes: 'المسارات والمحطات', alerts: 'الإشعارات', settings: 'الإعدادات', driver: 'تطبيق السائق' } as Record<Screen, string>)[screen]; }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.pattern}><Text style={styles.patternText}>✧ ❖ ✧ ❖ ✧ ❖ ✧ ❖ ✧</Text></View>
      <View style={styles.header}>
        <Pressable onPress={() => navigate('home')} style={styles.homeChip}><Text style={styles.homeChipText}>⌂  الرئيسية</Text></Pressable>
        <View style={styles.brandText}><Text style={styles.brandTitle}>TOBIS</Text><Text style={styles.brandSub}>النقل الحضري · المغرب</Text></View>
        <View style={styles.logo}><Text style={styles.logoText}>🚌</Text></View>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.pageTitle}>{titleForScreen()}</Text>
        {screen === 'home' && <>
          <Pressable onPress={() => { setDriverMode(false); navigate('map'); }} style={[styles.roleCard, styles.passengerCard]}><Text style={styles.roleIcon}>♙</Text><View style={styles.roleCopy}><Text style={styles.roleTitle}>دخول الراكب ←</Text><Text style={styles.roleSub}>اكتشف الحافلات والمسارات</Text></View><Text style={styles.chevron}>›</Text></Pressable>
          <Pressable onPress={() => { setDriverMode(true); navigate('driver'); }} style={[styles.roleCard, styles.driverCard]}><Text style={styles.roleIcon}>🚍</Text><View style={styles.roleCopy}><Text style={styles.roleTitle}>دخول السائق ←</Text><Text style={styles.roleSub}>تسجيل الرحلة ومشاركة GPS</Text></View><Text style={styles.chevron}>›</Text></Pressable>
          <Pressable onPress={() => navigate('map')} style={styles.heroMapCard}>
            <View style={styles.heroPhoto}><View style={styles.skyGlow}/><Text style={styles.mosque}>🕌</Text><Text style={styles.palms}>🌴  🌴  🌴</Text><Text style={styles.busArt}>🚌</Text><View style={styles.photoLabel}><Text style={styles.liveTag}>● GPS مباشر تجريبي</Text><Text style={styles.photoTitle}>حافلات المغرب · النقل الحضري</Text><Text style={styles.photoCaption}>تتبّع الموقع على الخريطة</Text></View></View>
            <View style={styles.heroBottom}><Text style={styles.heroGold}>✧  TOBIS · النقل في المدن المغربية  ✧</Text><Text style={styles.heroSmall}>اضغط لفتح الخريطة المباشرة</Text></View>
          </Pressable>
          <View style={styles.quickGrid}>
            <QuickCard icon="🗺️" title="الخريطة" onPress={() => navigate('map')} />
            <QuickCard icon="🔔" title="التنبيهات" onPress={() => navigate('alerts')} />
            <QuickCard icon="↗" title="المسارات" onPress={() => navigate('routes')} />
          </View>
          <Text style={styles.disclaimer}>نسخة تجريبية · مواقع ومسارات العرض توضيحية وليست بيانات تشغيل رسمية.</Text>
        </>}

        {screen === 'map' && <>
          <View style={styles.mapCard}>
            <View style={styles.mapHeading}><Text style={styles.cardTitle}>الخريطة المباشرة</Text><Text style={styles.pill}>{trips.length} مركبات تجريبية</Text></View>
            <MapView style={styles.map} region={mapRegion} onRegionChangeComplete={setMapRegion}>
              {trips.map((trip, index) => <Marker key={`${trip.vehicle}-${index}`} coordinate={trip.location} title={trip.vehicle} description={`${trip.line} · ${trip.demo ? 'بيانات توضيحية' : 'GPS محلي فقط'}`} pinColor={trip.demo ? '#f5b700' : '#0da57a'} />)}
              {location && <><Marker coordinate={location} title="موقعي" pinColor={COLORS.blue}/><Circle center={location} radius={accuracy ?? 25} strokeColor="#1769aa66" fillColor="#1769aa22" /></>}
              <Polyline coordinates={[TANGIER, { latitude: 35.7642, longitude: -5.827 }, { latitude: 35.761, longitude: -5.821 }]} strokeColor={COLORS.blue} strokeWidth={4} lineDashPattern={[8, 6]} />
            </MapView>
            <View style={styles.mapActions}><ActionButton title="موقعي" onPress={getMyLocation} secondary/><ActionButton title="حافلة تجريبية" onPress={demoVehicle}/></View>
            <Text style={styles.mapDisclaimer}>مسار ومركبات تجريبية · الخريطة تحتاج اتصالاً بالإنترنت.</Text>
          </View>
          <TripCard trip={latestTrip} />
        </>}

        {screen === 'driver' && <>
          <View style={styles.driverBanner}><Text style={styles.driverBus}>🚌</Text><View style={{ flex: 1 }}><Text style={styles.bannerTitle}>تسجيل وبث الرحلة</Text><Text style={styles.bannerSub}>سجّل بياناتك وابدأ GPS من الهاتف</Text></View><Text style={[styles.statusDot, tracking && styles.statusOn]}>{tracking ? '● مباشر' : '● متوقف'}</Text></View>
          <View style={styles.formCard}>
            <Field label="اسم السائق (اختياري)" value={driverName} onChangeText={setDriverName} placeholder="اسم السائق" />
            <Field label="رقم الهاتف / واتساب" value={phone} onChangeText={setPhone} placeholder="06XXXXXXXX" keyboardType="phone-pad" />
            <Field label="رقم ترقيم الحافلة (Matricule)" value={vehicle} onChangeText={setVehicle} placeholder="12 - أ - 25489" />
            <Field label="رقم الخط" value={line} onChangeText={setLine} placeholder="L1" />
            <View style={styles.metrics}><Metric value={tracking ? 'نشط' : 'جاهز'} label="حالة GPS"/><Metric value={accuracy ? `±${accuracy}م` : '—'} label="الدقة"/><Metric value={String(trips.find((t) => !t.demo)?.updatedAt ? 1 : 0)} label="نقاط حديثة"/></View>
            <View style={styles.actionRow}>{tracking ? <ActionButton title="إنهاء الرحلة" danger onPress={stopDriverTrip}/> : <ActionButton title="بدء GPS الرحلة" onPress={startDriverTrip}/>}</View>
            <Text style={styles.formNote}>{permission} · يبقى GPS محلياً على الهاتف حتى ربط Firebase. يلزم إبقاء التطبيق مفتوحاً لضمان التتبع.</Text>
          </View>
          <View style={styles.infoBox}><Text style={styles.infoTitle}>تنبيه للخصوصية</Text><Text style={styles.infoText}>لا تنشر رقم الهاتف أو موقع السائق للعامة. يلزم خادم موثّق وقواعد Firestore قبل مشاركة أي موقع بين الأجهزة.</Text></View>
        </>}

        {screen === 'routes' && <>
          <View style={styles.routeIntro}><Text style={styles.cardTitle}>المسارات والمحطات</Text><Text style={styles.formNote}>أمثلة تصميم فقط. ملف L1 في المستودع لم يتم التحقق من هندسته ومحطاته بعد.</Text></View>
          {ROUTE_STOPS.map((stop, index) => <View key={stop} style={styles.stopRow}><View style={styles.stopNumber}><Text style={styles.stopNumberText}>{index + 1}</Text></View><View style={{ flex: 1 }}><Text style={styles.stopName}>{stop}</Text><Text style={styles.stopMeta}>خط تجريبي · Tanger</Text></View><Text style={styles.stopTime}>{index * 3} د</Text></View>)}
          <ActionButton title="فتح الخريطة" onPress={() => navigate('map')}/>
        </>}

        {screen === 'alerts' && <>
          <View style={styles.formCard}>
            <Text style={styles.cardTitle}>تنبيهات الوصول</Text>
            <Text style={styles.formNote}>أدخل رقم واتساب والخط والمحطة لتسجيل التفضيلات على هذا الجهاز. الإرسال التلقائي إلى واتساب يحتاج backend وWhatsApp Business API؛ هذه النسخة لا ترسل رسائل بعيدة.</Text>
            <Field label="رقم واتساب دولي" value={phone} onChangeText={setPhone} placeholder="+212612345678" keyboardType="phone-pad" />
            <Field label="الخط" value={selectedLine} onChangeText={setSelectedLine} placeholder="L1" />
            <Text style={styles.fieldLabel}>المحطة المطلوبة</Text>
            <View style={styles.stopChoices}>{ROUTE_STOPS.map((stop) => <Pressable key={stop} onPress={() => setSelectedStop(stop)} style={[styles.stopChoice, selectedStop === stop && styles.stopChoiceActive]}><Text style={[styles.stopChoiceText, selectedStop === stop && styles.stopChoiceTextActive]}>{stop}</Text></Pressable>)}</View>
            <View style={styles.actionRow}><ActionButton title={subscribed ? 'التنبيهات مفعّلة' : 'تفعيل التنبيه على الهاتف'} onPress={subscribeAlerts}/><ActionButton title="إلغاء" secondary onPress={stopAlerts}/></View>
            <Text style={styles.formNote}>{lastAlert}</Text>
          </View>
          <View style={styles.infoBox}><Text style={styles.infoTitle}>رسالة WhatsApp تجريبية</Text><Text style={styles.infoText}>تستطيع فتح WhatsApp يدوياً برسالة جاهزة. الإرسال الآلي كل دقيقتين يتطلب خادم WhatsApp Business، موافقة المستلم، وبيانات ETA فعلية.</Text><ActionButton title="فتح WhatsApp برسالة" secondary onPress={shareWhatsApp}/></View>
        </>}

        {screen === 'settings' && <>
          <View style={styles.formCard}><Text style={styles.cardTitle}>الإعدادات</Text><SettingRow title="المدينة" value="طنجة · عرض توضيحي"/><SettingRow title="اللغة" value="العربية / Français (à venir)"/><SettingRow title="الاتصال" value="وضع محلي تجريبي"/><SettingRow title="الإصدار" value="TOBIS · prototype natif"/></View>
          <View style={styles.infoBox}><Text style={styles.infoTitle}>قبل الإطلاق</Text><Text style={styles.infoText}>أضف Firebase Auth/Firestore، قواعد وصول آمنة، Cloud Functions، مزود WhatsApp Business، وخطوط ومحطات موثّقة. لا تضع مفاتيح الخادم داخل التطبيق.</Text></View>
        </>}
      </ScrollView>

      <View style={styles.bottomNav}>
        <NavItem icon="⌂" title="الرئيسية" active={screen === 'home'} onPress={() => navigate('home')}/>
        <NavItem icon="➤" title="الخريطة" active={screen === 'map'} onPress={() => navigate('map')}/>
        <NavItem icon="♧" title="المسارات" active={screen === 'routes'} onPress={() => navigate('routes')}/>
        <NavItem icon="♧" title="الإشعارات" active={screen === 'alerts'} onPress={() => navigate('alerts')}/>
        <NavItem icon="⚙" title="الإعدادات" active={screen === 'settings'} onPress={() => navigate('settings')}/>
      </View>
    </SafeAreaView>
  );
}

function QuickCard({ icon, title, onPress }: { icon: string; title: string; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.quickCard}><Text style={styles.quickIcon}>{icon}</Text><Text style={styles.quickTitle}>{title}</Text></Pressable>; }
function ActionButton({ title, onPress, secondary, danger }: { title: string; onPress: () => void; secondary?: boolean; danger?: boolean }) { return <Pressable onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary, danger && styles.buttonDanger]}><Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text></Pressable>; }
function Field({ label, value, onChangeText, placeholder, keyboardType }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: 'default' | 'phone-pad' }) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#8ba0b4" keyboardType={keyboardType ?? 'default'} style={styles.input} textAlign="right"/></View>; }
function Metric({ value, label }: { value: string; label: string }) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }
function TripCard({ trip }: { trip: LiveTrip }) { return <View style={styles.tripCard}><View style={styles.tripHead}><Text style={styles.cardTitle}>بطاقة معلومات الحافلة</Text><Text style={styles.pill}>{trip.demo ? 'DEMO' : 'GPS محلي'}</Text></View><Text style={styles.tripVehicle}>{trip.vehicle}</Text><Text style={styles.tripLine}>{trip.city} · {trip.line}</Text><Text style={styles.tripMeta}>الموقع: {trip.location.latitude.toFixed(5)}, {trip.location.longitude.toFixed(5)}</Text><Text style={styles.formNote}>موقع توضيحي — ليس ETA تشغيلياً</Text></View>; }
function SettingRow({ title, value }: { title: string; value: string }) { return <View style={styles.settingRow}><Text style={styles.settingTitle}>{title}</Text><Text style={styles.settingValue}>{value}</Text></View>; }
function NavItem({ icon, title, active, onPress }: { icon: string; title: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.navItem, active && styles.navItemActive]}><Text style={[styles.navIcon, active && styles.navTextActive]}>{icon}</Text><Text numberOfLines={1} style={[styles.navLabel, active && styles.navTextActive]}>{title}</Text></Pressable>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f1f5f8' }, pattern: { height: 23, backgroundColor: COLORS.navy, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: COLORS.gold }, patternText: { color: COLORS.gold, letterSpacing: 4, fontSize: 13 },
  header: { minHeight: 76, paddingHorizontal: 15, backgroundColor: '#084779', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#e5b719' },
  homeChip: { borderWidth: 1, borderColor: '#cda92b', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: '#174e70' }, homeChipText: { color: '#ffe071', fontWeight: '800', fontSize: 13 }, brandText: { flex: 1, alignItems: 'flex-end', marginRight: 10 }, brandTitle: { color: COLORS.white, fontSize: 24, fontWeight: '900', letterSpacing: 1 }, brandSub: { color: '#ffdc5a', fontWeight: '800', fontSize: 12, marginTop: 1 }, logo: { width: 48, height: 48, borderRadius: 15, backgroundColor: COLORS.gold, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }, logoText: { fontSize: 25 },
  content: { padding: 15, paddingBottom: 28 }, pageTitle: { color: COLORS.navy, fontSize: 19, fontWeight: '900', textAlign: 'right', marginBottom: 13 },
  roleCard: { minHeight: 74, borderRadius: 18, marginBottom: 11, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 12, elevation: 3 }, passengerCard: { backgroundColor: '#08ae86' }, driverCard: { backgroundColor: '#ff8b00' }, roleIcon: { width: 43, height: 43, overflow: 'hidden', textAlign: 'center', textAlignVertical: 'center', borderRadius: 13, backgroundColor: '#ffffff35', color: '#fff', fontSize: 25 }, roleCopy: { flex: 1, alignItems: 'flex-end' }, roleTitle: { color: '#fff', fontSize: 17, fontWeight: '900' }, roleSub: { color: '#fff6db', fontSize: 12, fontWeight: '700', marginTop: 3 }, chevron: { color: '#fff9cb', fontSize: 27 },
  heroMapCard: { borderRadius: 27, borderWidth: 4, borderColor: COLORS.gold, padding: 7, marginTop: 17, marginBottom: 14, backgroundColor: COLORS.navy, overflow: 'hidden', elevation: 5 }, heroPhoto: { height: 302, borderRadius: 20, backgroundColor: '#87bbd2', overflow: 'hidden', justifyContent: 'space-between', padding: 12 }, skyGlow: { ...StyleSheet.absoluteFillObject, backgroundColor: '#92c7dc' }, mosque: { position: 'absolute', top: 40, left: 16, fontSize: 90, opacity: 0.88 }, palms: { position: 'absolute', top: 75, right: 7, fontSize: 33 }, busArt: { position: 'absolute', bottom: 76, right: 4, fontSize: 105, transform: [{ scaleX: -1 }] }, photoLabel: { zIndex: 1, alignItems: 'flex-end', gap: 6 }, liveTag: { color: '#73e6bc', backgroundColor: '#082d29', overflow: 'hidden', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7, fontWeight: '900' }, photoTitle: { color: '#fff', backgroundColor: '#101d36dd', borderRadius: 13, paddingHorizontal: 11, paddingVertical: 8, fontWeight: '900', fontSize: 17 }, photoCaption: { color: '#ffe073', backgroundColor: '#101d36cc', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6, fontWeight: '800' }, heroBottom: { paddingTop: 9, alignItems: 'center' }, heroGold: { color: COLORS.gold, fontWeight: '900', fontSize: 13, textAlign: 'center' }, heroSmall: { color: '#d9e8f4', fontSize: 11, marginTop: 3 },
  quickGrid: { flexDirection: 'row', gap: 9, marginTop: 4 }, quickCard: { flex: 1, borderRadius: 15, padding: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line, alignItems: 'center' }, quickIcon: { color: COLORS.blue, fontSize: 22 }, quickTitle: { color: COLORS.navy, fontWeight: '800', fontSize: 11, marginTop: 4 }, disclaimer: { textAlign: 'center', color: COLORS.muted, fontSize: 11, marginTop: 15, lineHeight: 17 },
  mapCard: { borderRadius: 18, backgroundColor: '#fff', overflow: 'hidden', borderWidth: 1, borderColor: COLORS.line }, mapHeading: { padding: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, cardTitle: { color: COLORS.navy, fontWeight: '900', fontSize: 17, textAlign: 'right' }, pill: { color: '#11694d', backgroundColor: '#e6f7ee', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20, fontWeight: '800', fontSize: 10 }, map: { height: 370, width: '100%' }, mapActions: { flexDirection: 'row', gap: 8, padding: 10 }, mapDisclaimer: { color: COLORS.muted, fontSize: 10, textAlign: 'right', paddingHorizontal: 12, paddingBottom: 11 }, tripCard: { backgroundColor: COLORS.navy, borderRadius: 18, marginTop: 13, padding: 16 }, tripHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, tripVehicle: { color: COLORS.gold, fontSize: 22, fontWeight: '900', textAlign: 'right', marginTop: 13 }, tripLine: { color: '#fff', fontWeight: '800', textAlign: 'right', marginTop: 4 }, tripMeta: { color: '#c6d6e5', textAlign: 'right', marginTop: 9, fontSize: 12 },
  driverBanner: { backgroundColor: '#123d76', borderWidth: 1, borderColor: COLORS.gold, borderRadius: 18, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 12 }, driverBus: { fontSize: 35 }, bannerTitle: { color: '#fff', fontSize: 18, fontWeight: '900', textAlign: 'right' }, bannerSub: { color: '#c6d8ed', textAlign: 'right', fontSize: 11, marginTop: 4 }, statusDot: { color: '#f2ce67', fontSize: 10, fontWeight: '900' }, statusOn: { color: '#51e1a8' }, formCard: { backgroundColor: '#17447e', borderWidth: 1, borderColor: '#456b9c', borderRadius: 19, padding: 15, gap: 10 }, field: { gap: 5 }, fieldLabel: { color: COLORS.gold, textAlign: 'right', fontSize: 13, fontWeight: '900' }, input: { minHeight: 47, borderRadius: 13, backgroundColor: '#101f3a', borderWidth: 1, borderColor: '#314d72', color: '#fff', paddingHorizontal: 13, fontSize: 15, fontWeight: '700' }, metrics: { flexDirection: 'row', gap: 8, marginTop: 5 }, metric: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 13, backgroundColor: '#ffffff12' }, metricValue: { color: '#fff', fontSize: 16, fontWeight: '900' }, metricLabel: { color: '#c2d2e4', fontSize: 10, marginTop: 3 }, actionRow: { flexDirection: 'row', gap: 8, marginTop: 5 }, button: { minHeight: 45, flex: 1, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.gold }, buttonText: { color: '#15263a', fontWeight: '900', textAlign: 'center', fontSize: 13 }, buttonSecondary: { backgroundColor: '#e8f2f8' }, buttonSecondaryText: { color: COLORS.blue }, buttonDanger: { backgroundColor: '#c63d39' }, formNote: { color: '#c5d4e4', textAlign: 'right', fontSize: 11, lineHeight: 17, marginTop: 5 }, infoBox: { marginTop: 12, borderRadius: 15, padding: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line, gap: 8 }, infoTitle: { color: COLORS.navy, textAlign: 'right', fontWeight: '900' }, infoText: { color: COLORS.muted, textAlign: 'right', fontSize: 12, lineHeight: 19 },
  routeIntro: { backgroundColor: '#fff', padding: 15, borderRadius: 16, gap: 7, marginBottom: 10 }, stopRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, marginBottom: 8 }, stopNumber: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.blue, justifyContent: 'center', alignItems: 'center' }, stopNumberText: { color: '#fff', fontWeight: '900' }, stopName: { color: COLORS.navy, textAlign: 'right', fontWeight: '800' }, stopMeta: { color: COLORS.muted, textAlign: 'right', fontSize: 10, marginTop: 3 }, stopTime: { color: COLORS.blue, fontWeight: '900' }, stopChoices: { gap: 7 }, stopChoice: { borderColor: COLORS.line, borderWidth: 1, borderRadius: 11, padding: 11, backgroundColor: '#fff' }, stopChoiceActive: { backgroundColor: '#eaf5ff', borderColor: COLORS.blue }, stopChoiceText: { color: COLORS.ink, textAlign: 'right', fontSize: 12 }, stopChoiceTextActive: { color: COLORS.blue, fontWeight: '900' }, settingRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, settingTitle: { color: COLORS.navy, fontWeight: '800' }, settingValue: { color: COLORS.muted, fontSize: 12, textAlign: 'right', flex: 1 },
  bottomNav: { minHeight: 68, paddingHorizontal: 3, paddingTop: 5, paddingBottom: Platform.OS === 'android' ? 4 : 0, borderTopWidth: 1, borderTopColor: COLORS.line, backgroundColor: '#fff', flexDirection: 'row', justifyContent: 'space-around' }, navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 13, gap: 1 }, navItemActive: { backgroundColor: '#eaf5ff' }, navIcon: { color: '#8295aa', fontSize: 21, height: 25 }, navLabel: { color: '#64788d', fontSize: 9, fontWeight: '800' }, navTextActive: { color: COLORS.blue }
});
