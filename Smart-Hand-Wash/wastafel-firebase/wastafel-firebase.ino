#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <Preferences.h>
#include <time.h>

// Isi konfigurasi Firebase dan Wi-Fi Anda sebelum mengunggah.
const char* WIFI_SSID = "Redmi Note 13";
const char* WIFI_PASSWORD = "1234567890";
const char* FIREBASE_API_KEY = "AIzaSyDc-iROnDBGRYv97iJZxKnEJ4QpqP31KZo";
const char* DATABASE_URL = "https://wastafel-pintar-default-rtdb.asia-southeast1.firebasedatabase.app";
const char* DEVICE_ID = "wastafel-01";
const char* DEVICE_EMAIL = "wastafelpintar@gmail.com";
const char* DEVICE_PASSWORD = "WastafelPintar01";

const uint8_t IR_SABUN=32, IR_AIR=33, TRIG_PIN=5, ECHO_PIN=19, FLOW_PIN=18;
const uint8_t RELAY_SABUN=26, RELAY_AIR=27;
// Sensor IR umum memberi LOW saat objek terdeteksi. Jika output modul Anda
// justru HIGH saat mendeteksi, ubah nilai sensor tersebut menjadi false.
const bool IR_SABUN_AKTIF_LOW=true, IR_AIR_AKTIF_LOW=true;
const bool RELAY_AKTIF_LOW=true;
const float KAPASITAS_GALON_ML=15000.0;
// AJ-SR04M memiliki area buta sekitar 20 cm. Nilai 20-60 cm ini hanya
// perkiraan sementara; kalibrasi CAL di Serial Monitor akan menggantinya.
// Jarak kosong mengikuti bacaan AJ-SR04M 42 cm pada galon kosong; kalibrasikan titik penuh
// melalui Serial Monitor agar persentase dan bentuk galon terpetakan akurat.
// Hasil ukur AJ-SR04M: penuh 20.1 cm (15 L), kosong 42 cm (0 L).
// Silinder dihitung proporsional terhadap tinggi air; titik CAL dapat mengganti pemetaan ini.
const float JARAK_PENUH_CM=20.1, JARAK_KOSONG_CM=42.0;
// Nilai awal untuk flow meter tipe YF-S201; kalibrasikan bila model sensornya berbeda.
const float PULSA_PER_LITER=450.0;
const float VOLUME_TITIK_KALIBRASI_ML[6]={0,3000,6000,9000,12000,15000};
// Abaikan pulsa/noise singkat dari modul IR supaya pompa tidak berkedip.
const unsigned long IR_DEBOUNCE_ON_MS=60, IR_DEBOUNCE_OFF_MS=80;
const unsigned long BATAS_POMPA_SABUN_MS=2000;

volatile uint32_t totalPulsaFlow=0, pulsaFlowTerakhirUs=0;
unsigned long pulsaAwalSesi=0, pulsaSesiTerakhir=0, lastPush=0, lastAuth=0;
float volumeAirML=0, jarakCM=-1, sisaAirML=0;
bool levelValid=false, tanganSabun=false, tanganAir=false;
bool pompaSabunON=false, pompaAirON=false, tanganAirSebelumnya=false;
bool soapSessionActive=false, waterPumpSessionActive=false;
bool prevSoap=false, prevWater=false;
int rawSabunTerakhir=HIGH, rawAirTerakhir=HIGH;
unsigned long rawSabunBerubahPada=0, rawAirBerubahPada=0;
unsigned long mulaiPompaSabun=0;
bool sabunTimeout=false;
bool sabunArmed=true, airArmed=false;
bool wifiWasConnected=false;
bool statusNeedsPush=false;
unsigned long sabunTidakTerdeteksiSejak=0, airTidakTerdeteksiSejak=0;
String idToken;
String bootId;
struct PumpEvent { String id; const char* pump; float volumeMl; uint32_t eventTime; };
const uint8_t MAX_PENDING_EVENTS=50;
const char* FIRMWARE_VERSION="2026.11.05-flow-session-retained";
PumpEvent pendingEvents[MAX_PENDING_EVENTS];
uint8_t pendingEventCount=0;
uint32_t eventSequence=0;
String activeWaterEventId;
String lastSoapEventId;
uint32_t activeWaterEventTime=0;
float activeWaterFinalMl=0;
bool activeWaterEvent=false, waterEventNeedsQueue=false, waterEventFinalized=false;
unsigned long lastDebug=0;
unsigned long lastWifiRetry=0;
const unsigned long WIFI_RETRY_INTERVAL_MS=30000;
int lastFirebaseHttpCode=0;
WebServer setupServer(80);
Preferences wifiPreferences;
Preferences usagePreferences;
Preferences levelPreferences;
uint32_t soapCount=0, waterCount=0;
float levelCalibrationCm[6]={0,0,0,0,0,0};
const char* SETUP_AP_SSID="Wastafel-Pintar-Setup";
const char* SETUP_AP_PASSWORD="wastafel123";
bool setupPortalActive=false;
bool usageCountersInitialized=false;

void IRAM_ATTR hitungPulsaFlow(){
  uint32_t sekarang=micros();
  // Abaikan spike listrik sangat singkat, tetapi biarkan pulsa flow meter normal.
  if((uint32_t)(sekarang-pulsaFlowTerakhirUs)>=1000UL){
    totalPulsaFlow++;
    pulsaFlowTerakhirUs=sekarang;
  }
}
unsigned long bacaTotalPulsa(){ noInterrupts(); unsigned long n=totalPulsaFlow; interrupts(); return n; }
float hitungVolumeML(unsigned long n){ return (float(n)/PULSA_PER_LITER)*1000.0; }
bool bacaIRStabil(uint8_t pin,bool aktifLow,int &rawSebelumnya,unsigned long &berubahPada,bool nilaiStabil){
  int raw=digitalRead(pin);
  if(raw!=rawSebelumnya){rawSebelumnya=raw;berubahPada=millis();}
  bool terdeteksi=aktifLow?(raw==LOW):(raw==HIGH);
  unsigned long stabilMs=terdeteksi?IR_DEBOUNCE_ON_MS:IR_DEBOUNCE_OFF_MS;
  if(millis()-berubahPada>=stabilMs)return terdeteksi;
  return nilaiStabil;
}
void aturRelay(uint8_t pin,bool on){ digitalWrite(pin, RELAY_AKTIF_LOW ? (on?LOW:HIGH) : (on?HIGH:LOW)); }
float bacaJarak(){ digitalWrite(TRIG_PIN,LOW); delayMicroseconds(3); digitalWrite(TRIG_PIN,HIGH); delayMicroseconds(10); digitalWrite(TRIG_PIN,LOW); unsigned long d=pulseIn(ECHO_PIN,HIGH,30000UL); return d==0?-1.0:d*0.0343/2.0; }
float hitungSisaDariJarak(float distance){
  int valid[6], count=0;
  for(int i=0;i<6;i++)if(levelCalibrationCm[i]>=20.0&&levelCalibrationCm[i]<=400.0)valid[count++]=i;
  // Dua titik volume yang valid sudah cukup untuk interpolasi galon.
  if(count>=2){
    bool profileValid=true;
    for(int n=0;n<count-1;n++)if(levelCalibrationCm[valid[n]]<=levelCalibrationCm[valid[n+1]])profileValid=false;
    if(!profileValid)count=0; // jarak wajib makin pendek saat volume bertambah
  }
  if(count>=2){
    float emptyDistance=levelCalibrationCm[valid[0]], fullDistance=levelCalibrationCm[valid[count-1]];
    if(distance>=emptyDistance)return VOLUME_TITIK_KALIBRASI_ML[valid[0]];
    if(distance<=fullDistance)return VOLUME_TITIK_KALIBRASI_ML[valid[count-1]];
    for(int n=0;n<count-1;n++){
      int low=valid[n], high=valid[n+1];
      float dLow=levelCalibrationCm[low], dHigh=levelCalibrationCm[high];
      if(distance<=dLow&&distance>=dHigh&&dLow>dHigh){
        float f=(dLow-distance)/(dLow-dHigh);
        return VOLUME_TITIK_KALIBRASI_ML[low]+f*(VOLUME_TITIK_KALIBRASI_ML[high]-VOLUME_TITIK_KALIBRASI_ML[low]);
      }
    }
  }
  // Perkiraan sementara sampai titik kalibrasi galon diukur.
  float f=constrain((JARAK_KOSONG_CM-distance)/(JARAK_KOSONG_CM-JARAK_PENUH_CM),0.0,1.0);
  return f*KAPASITAS_GALON_ML;
}
void perbaruiLevel(){
  float x=bacaJarak();
  // Tolak pantulan di area buta AJ-SR04M; angka dekat biasanya tidak stabil.
  if(x<20.0||x>400.0){levelValid=false;jarakCM=-1;return;}
  jarakCM=x; sisaAirML=hitungSisaDariJarak(jarakCM); levelValid=true;
}
void tampilkanTitikKalibrasi(){
  Serial.println("Kalibrasi galon (jarak sensor -> sisa air):");
  for(int i=0;i<6;i++)Serial.printf("  CAL %.0f mL : %.1f cm\n",VOLUME_TITIK_KALIBRASI_ML[i],levelCalibrationCm[i]);
  Serial.println("Isi tiap titik dengan volume tersisa yang diketahui, lalu kirim: CAL 0 / 3000 / 6000 / 9000 / 12000 / 15000");
}
void kalibrasiLevel(float volumeMl){
  int index=-1;
  for(int i=0;i<6;i++)if(volumeMl==VOLUME_TITIK_KALIBRASI_ML[i])index=i;
  if(index<0){Serial.println("Volume kalibrasi harus 0, 3000, 6000, 9000, 12000, atau 15000 mL.");return;}
  float samples[7];int count=0;
  for(int i=0;i<7;i++){float d=bacaJarak();if(d>=20.0&&d<=400.0)samples[count++]=d;delay(80);}
  if(count<3){Serial.println("Kalibrasi gagal: echo valid kurang dari 3. Cek mode AJ-SR04M dan jarak minimum 20 cm.");return;}
  for(int i=0;i<count-1;i++)for(int j=i+1;j<count;j++)if(samples[i]>samples[j]){float t=samples[i];samples[i]=samples[j];samples[j]=t;}
  levelCalibrationCm[index]=samples[count/2];
  char key[4];snprintf(key,sizeof(key),"d%d",index);
  levelPreferences.putFloat(key,levelCalibrationCm[index]);
  Serial.printf("Tersimpan: %.0f mL = %.1f cm\n",volumeMl,levelCalibrationCm[index]);
  tampilkanTitikKalibrasi();
}
void prosesPerintahSerial(){
  if(!Serial.available())return;
  String command=Serial.readStringUntil('\n');command.trim();command.toUpperCase();
  if(command=="CAL?"){tampilkanTitikKalibrasi();return;}
  if(command=="CAL CLEAR"){
    for(int i=0;i<6;i++){char key[4];snprintf(key,sizeof(key),"d%d",i);levelCalibrationCm[i]=0;levelPreferences.remove(key);}
    Serial.println("Titik kalibrasi dihapus; profil kembali ke perkiraan sementara.");return;
  }
  if(command.startsWith("CAL ")){kalibrasiLevel(command.substring(4).toFloat());return;}
  Serial.println("Perintah: CAL? | CAL CLEAR | CAL 0/3000/6000/9000/12000/15000");
}

bool firebaseRequest(const String& url,const String& method,const String& body,String* response=nullptr){
  WiFiClientSecure client; client.setInsecure(); // demo: untuk produksi pasang CA certificate
  // Batasi waktu tunggu agar request Firebase tidak lama menahan pembacaan sensor.
  HTTPClient http; http.setConnectTimeout(800); http.setTimeout(800);
  if(!http.begin(client,url)){lastFirebaseHttpCode=-1;Serial.println("Firebase: gagal membuka koneksi HTTPS");return false;}
  http.addHeader("Content-Type","application/json");
  int code=method=="PUT"?http.PUT(body):method=="GET"?http.GET():http.PATCH(body); String payload=http.getString(); http.end();
  lastFirebaseHttpCode=code;
  if(response) *response=payload; Serial.printf("Firebase HTTP %d\n",code);
  if(code<200||code>=300) Serial.println(payload);
  return code>=200&&code<300;
}
String dbUrl(const String& path){ return String(DATABASE_URL)+"/devices/"+DEVICE_ID+path+".json?auth="+idToken; }
bool pastikanLogin();
bool firebaseRequestDenganRefresh(const String& url,const String& method,const String& body){
  if(firebaseRequest(url,method,body)) return true;
  if(lastFirebaseHttpCode!=401) return false;
  Serial.println("Token Firebase ditolak (401); login ulang lalu coba kirim sekali lagi");
  idToken="";
  if(!pastikanLogin()) return false;
  return firebaseRequest(url,method,body);
}
bool loginFirebase(){
  WiFiClientSecure client; client.setInsecure(); HTTPClient http;
  http.setConnectTimeout(800); http.setTimeout(800);
  String url=String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=")+FIREBASE_API_KEY;
  if(!http.begin(client,url)) return false; http.addHeader("Content-Type","application/json");
  StaticJsonDocument<256> req; req["email"]=DEVICE_EMAIL; req["password"]=DEVICE_PASSWORD; req["returnSecureToken"]=true;
  String body; serializeJson(req,body); int code=http.POST(body); String out=http.getString(); http.end();
  if(code!=200){Serial.printf("Login Firebase gagal: %d %s\n",code,out.c_str());return false;}
  StaticJsonDocument<2048> doc;
  DeserializationError error=deserializeJson(doc,out);
  if(error){Serial.printf("Respons login Firebase gagal dibaca: %s\n",error.c_str());return false;}
  idToken=doc["idToken"].as<String>(); lastAuth=millis();
  if(idToken.length()==0){Serial.println("Login Firebase berhasil tetapi idToken kosong");return false;}
  Serial.println("Login Firebase berhasil");
  return true;
}
void inisialisasiHitunganDariFirebase(){
  if(usageCountersInitialized||!pastikanLogin())return;
  uint32_t soapFromHistory=0,waterFromHistory=0;
  const String historyUrls[2]={dbUrl("/events"),String(DATABASE_URL)+"/devices/wastafel-pintar/events.json?auth="+idToken};
  const uint8_t historyCount=String(DEVICE_ID)=="wastafel-pintar"?1:2;
  for(uint8_t source=0;source<historyCount;source++){
    String payload;
    if(!firebaseRequest(historyUrls[source],"GET","",&payload))return;
    DynamicJsonDocument doc(49152);
    DeserializationError error=deserializeJson(doc,payload);
    if(error){Serial.printf("Riwayat Firebase terlalu besar/gagal dibaca untuk sinkron hitungan: %s\n",error.c_str());return;}
    JsonObjectConst events=doc.as<JsonObjectConst>();
    for(JsonPairConst item:events){
      String pump=item.value()["pump"]|"";pump.toLowerCase();
      if(pump=="sabun"||pump=="soap"||pump=="pompa sabun")soapFromHistory++;
      else if(pump=="air"||pump=="water"||pump=="pompa air")waterFromHistory++;
    }
  }
  soapCount=max(soapCount,soapFromHistory);waterCount=max(waterCount,waterFromHistory);
  usagePreferences.putUInt("soapCount",soapCount);usagePreferences.putUInt("waterCount",waterCount);
  usagePreferences.putBool("initialized",true);usageCountersInitialized=true;
  Serial.printf("Hitungan diselaraskan dengan Firebase: sabun=%lu air=%lu\n",(unsigned long)soapCount,(unsigned long)waterCount);
}
bool antreEvent(const char* pump,float ml,String* eventIdOut=nullptr){
  if(pendingEventCount>=MAX_PENDING_EVENTS){Serial.println("ANTREAN EVENT PENUH - pemakaian baru ditahan agar jumlah tidak hilang");return false;}
  PumpEvent &e=pendingEvents[pendingEventCount++];
  e.id=bootId+"-"+String(++eventSequence); e.pump=pump; e.volumeMl=ml; e.eventTime=(uint32_t)time(nullptr);
  if(eventIdOut)*eventIdOut=e.id;
  Serial.printf("EVENT DITAMBAHKAN: pompa %s, id=%s\n",pump,e.id.c_str());
  return true;
}
void mulaiEventAir(){
  if(activeWaterEvent)return;
  activeWaterEventId=bootId+"-"+String(++eventSequence);
  activeWaterEventTime=(uint32_t)time(nullptr);
  activeWaterFinalMl=0;
  activeWaterEvent=true;
  waterPumpSessionActive=true;
  waterEventFinalized=false;
  // Catat pemakaian segera saat pompa mulai agar dashboard tetap menghitung
  // setelah halaman dimuat ulang. Volume sesi akan diperbarui saat selesai.
  waterEventNeedsQueue=true;
}
void selesaikanEventAir(float volumeMl){
  if(!activeWaterEvent)return;
  statusNeedsPush=true;
  waterPumpSessionActive=false;
  activeWaterFinalMl=volumeMl;
  waterEventFinalized=true;
  // Jika event awal masih mengantre lokal, perbarui volume tanpa membuat
  // event kedua untuk sesi pompa yang sama.
  for(uint8_t i=0;i<pendingEventCount;i++){
    if(pendingEvents[i].id==activeWaterEventId){
      pendingEvents[i].volumeMl=activeWaterFinalMl;
      activeWaterEvent=false;
      waterEventNeedsQueue=false;
      return;
    }
  }
  // Event awal mungkin sudah terkirim; tulis ulang ID yang sama dengan
  // volume akhir agar Firebase tetap hanya memiliki satu pemakaian.
  waterEventNeedsQueue=true;
}
void antrekanEventAirJikaSiap(){
  if(!waterEventNeedsQueue || pendingEventCount>=MAX_PENDING_EVENTS)return;
  PumpEvent &e=pendingEvents[pendingEventCount++];
  e.id=activeWaterEventId; e.pump="air"; e.volumeMl=activeWaterFinalMl; e.eventTime=activeWaterEventTime;
  Serial.printf("EVENT DITAMBAHKAN: pompa air, volume=%.1f mL, id=%s\n",e.volumeMl,e.id.c_str());
  waterEventNeedsQueue=false;
  if(waterEventFinalized)activeWaterEvent=false;
}
bool pastikanLogin(){
  if(WiFi.status()!=WL_CONNECTED){Serial.printf("Kirim Firebase dilewati: Wi-Fi belum tersambung (status=%d)\n",WiFi.status());return false;}
  if(idToken.length()==0 || millis()-lastAuth>3000000UL){Serial.println("Meminta token Firebase...");return loginFirebase();}
  return true;
}
void kirimEventTertunda(){
  if(pendingEventCount==0)return;
  Serial.printf("Mengirim antrean Firebase: %u event\n",pendingEventCount);
  if(!pastikanLogin())return;
  uint8_t terkirim=0;
  while(pendingEventCount>0 && terkirim<5){
    PumpEvent &e=pendingEvents[0];
    StaticJsonDocument<256> doc; doc["pump"]=e.pump; doc["volumeMl"]=e.volumeMl; doc["uptimeMs"]=millis(); doc["time"]=e.eventTime;
    String body; serializeJson(doc,body);
    if(!firebaseRequestDenganRefresh(dbUrl("/events/"+e.id),"PUT",body)){
      Serial.printf("Event gagal disimpan (HTTP %d); tetap di antrean untuk dicoba lagi\n",lastFirebaseHttpCode);
      break;
    }
    Serial.printf("EVENT TERSIMPAN: pompa %s\n",e.pump);
    for(uint8_t i=1;i<pendingEventCount;i++)pendingEvents[i-1]=pendingEvents[i];
    pendingEventCount--; terkirim++;
  }
}
bool kirimStatus(){
  if(!pastikanLogin())return false;
  StaticJsonDocument<512> d; d["soapHand"]=tanganSabun; d["waterHand"]=tanganAir; d["soapPump"]=pompaSabunON; d["waterPump"]=pompaAirON;
  d["soapCount"]=soapCount; d["waterCount"]=waterCount; d["firmwareVersion"]=FIRMWARE_VERSION;
  d["soapEventId"]=lastSoapEventId; d["waterEventId"]=activeWaterEventId;
  d["sessionMl"]=volumeAirML;
  d["sessionPulses"]=tanganAir?(bacaTotalPulsa()-pulsaAwalSesi):pulsaSesiTerakhir;
  d["flowTotalPulses"]=bacaTotalPulsa();
  d["levelValid"]=levelValid; d["distanceCm"]=jarakCM;
  d["remainingMl"]=sisaAirML; d["updatedAt"]=(uint32_t)time(nullptr); d["online"]=true;
  String body; serializeJson(d,body);
  if(!firebaseRequestDenganRefresh(dbUrl("/current"),"PUT",body)){
    Serial.printf("Status perangkat gagal dikirim (HTTP %d)\n",lastFirebaseHttpCode);
    return false;
  }
  return true;
}
void kontrolDispenser(){
  tanganSabun=bacaIRStabil(IR_SABUN,IR_SABUN_AKTIF_LOW,rawSabunTerakhir,rawSabunBerubahPada,tanganSabun);
  tanganAir=bacaIRStabil(IR_AIR,IR_AIR_AKTIF_LOW,rawAirTerakhir,rawAirBerubahPada,tanganAir);
  bool sesiAirBaruSelesai=!tanganAir&&tanganAirSebelumnya;
  // Satu pemakaian per deteksi. Sensor harus stabil tidak mendeteksi tangan
  // selama 500 ms sebelum pompa dapat dipicu lagi.
  if(!tanganSabun){
    soapSessionActive=false;
    if(sabunTidakTerdeteksiSejak==0)sabunTidakTerdeteksiSejak=millis();
    if(millis()-sabunTidakTerdeteksiSejak>=500){sabunArmed=true;sabunTimeout=false;}
  }else sabunTidakTerdeteksiSejak=0;
  if(!tanganAir){
    if(airTidakTerdeteksiSejak==0)airTidakTerdeteksiSejak=millis();
    if(millis()-airTidakTerdeteksiSejak>=200)airArmed=true;
  }else airTidakTerdeteksiSejak=0;
  if(tanganAir&&!tanganAirSebelumnya){
    pulsaAwalSesi=bacaTotalPulsa();
    pulsaSesiTerakhir=0;
    volumeAirML=0;
  }
  if(tanganAir||sesiAirBaruSelesai){
    pulsaSesiTerakhir=bacaTotalPulsa()-pulsaAwalSesi;
    volumeAirML=hitungVolumeML(pulsaSesiTerakhir);
  }
  float volumeSebelumReset=volumeAirML;
  bool mulaiSabun=tanganSabun&&sabunArmed;
  bool mulaiAir=tanganAir&&!tanganAirSebelumnya&&airArmed&&!activeWaterEvent;
  if(mulaiSabun){
    sabunArmed=false;mulaiPompaSabun=millis();
    soapSessionActive=antreEvent("sabun",0,&lastSoapEventId);
    if(!soapSessionActive)sabunTimeout=true;
  }
  if(mulaiAir){airArmed=false;mulaiEventAir();}
  bool mintaSabun=tanganSabun&&soapSessionActive&&!sabunTimeout;
  // Pompa air mengikuti sensor tangan: ON selama tangan terdeteksi, OFF
  // segera setelah sensor menyatakan tangan sudah menjauh. Volume flow meter
  // hanya dicatat; tidak ada target mL atau batas waktu yang mematikan pompa.
  bool mintaAir=tanganAir;
  if(mintaSabun&&millis()-mulaiPompaSabun>=BATAS_POMPA_SABUN_MS){sabunTimeout=true;soapSessionActive=false;mintaSabun=false;Serial.println("PENGAMAN: pompa sabun dihentikan setelah batas waktu; jauhkan tangan untuk reset");}
  pompaSabunON=mintaSabun; pompaAirON=mintaAir;
  // Satu hitungan persis ketika relay mulai ON; tersimpan meski ESP32 restart.
  if(pompaSabunON&&!prevSoap){soapCount++;usagePreferences.putUInt("soapCount",soapCount);statusNeedsPush=true;Serial.printf("HITUNGAN POMPA SABUN: %lu\n",(unsigned long)soapCount);}
  if(pompaAirON&&!prevWater){waterCount++;usagePreferences.putUInt("waterCount",waterCount);statusNeedsPush=true;Serial.printf("HITUNGAN POMPA AIR: %lu\n",(unsigned long)waterCount);}
  if(activeWaterEvent&&sesiAirBaruSelesai)
    selesaikanEventAir(volumeSebelumReset);
  antrekanEventAirJikaSiap();
  aturRelay(RELAY_SABUN,pompaSabunON); aturRelay(RELAY_AIR,pompaAirON);
  prevSoap=pompaSabunON;prevWater=pompaAirON;tanganAirSebelumnya=tanganAir;
}
void mulaiPortalWiFi(){
  WiFi.mode(WIFI_AP_STA);
  bool apBerhasil=WiFi.softAP(SETUP_AP_SSID,SETUP_AP_PASSWORD);
  if(!apBerhasil){Serial.println("Portal Wi-Fi gagal dibuat");return;}
  setupPortalActive=true;
  Serial.printf("PORTAL WIFI: sambungkan ponsel/PC ke %s (kata sandi: %s)\n",SETUP_AP_SSID,SETUP_AP_PASSWORD);
  Serial.printf("Buka alamat http://%s untuk memasukkan Wi-Fi internet\n",WiFi.softAPIP().toString().c_str());

  setupServer.on("/",HTTP_GET,[](){
    const char* page=R"HTML(<!doctype html><html lang="id"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Atur Wi-Fi Wastafel</title><style>body{font:16px system-ui;background:#101827;color:#eef2f7;max-width:520px;margin:32px auto;padding:20px}main{background:#1b2638;padding:24px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:13px;margin:8px 0;border-radius:8px;border:1px solid #526078;font:inherit}input{background:#101827;color:white}button{background:#168ddd;color:white;border:0;font-weight:700}small,#status{color:#b8c4d6}</style><main><h2>Hubungkan Wastafel Pintar</h2><p>Masukkan Wi-Fi yang memiliki internet. Gunakan jaringan 2,4 GHz.</p><form action="/connect" method="post"><label>Nama Wi-Fi (SSID)<input name="ssid" required autocomplete="off"></label><label>Kata sandi Wi-Fi<input name="password" type="password" autocomplete="off"></label><button type="submit">Simpan dan sambungkan</button></form><p id="status">Memeriksa koneksi...</p><small>Setelah tersambung, buka kembali dashboard melalui jaringan internet.</small></main><script>async function cek(){try{const r=await fetch('/status');const s=await r.json();document.getElementById('status').textContent=s.connected?'Wi-Fi tersambung. IP: '+s.ip:'Belum tersambung. Periksa nama dan kata sandi.'}catch{document.getElementById('status').textContent='Mencoba menyambung...' }}setInterval(cek,2500);cek()</script></html>)HTML";
    setupServer.send(200,"text/html; charset=utf-8",page);
  });
  setupServer.on("/connect",HTTP_POST,[](){
    String ssid=setupServer.arg("ssid");
    String password=setupServer.arg("password");
    ssid.trim();
    if(ssid.length()==0){setupServer.send(400,"text/plain","Nama Wi-Fi tidak boleh kosong.");return;}
    wifiPreferences.begin("wastafel-wifi",false);
    wifiPreferences.putString("ssid",ssid);
    wifiPreferences.putString("password",password);
    wifiPreferences.end();
    setupServer.send(200,"text/html; charset=utf-8","<meta name='viewport' content='width=device-width'><h2>Wi-Fi disimpan</h2><p>ESP32 sedang mencoba tersambung. Muat ulang halaman ini beberapa detik lagi.</p><a href='/'>Kembali</a>");
    WiFi.disconnect(false,false);
    delay(250);
    WiFi.begin(ssid.c_str(),password.c_str());
    lastWifiRetry=millis();
    Serial.printf("Mencoba Wi-Fi dari portal: %s\n",ssid.c_str());
  });
  setupServer.on("/status",HTTP_GET,[](){
    String body="{\"connected\":";
    body+=WiFi.status()==WL_CONNECTED?"true":"false";
    body+=",\"ip\":\""+WiFi.localIP().toString()+"\",\"status\":"+String((int)WiFi.status())+"}";
    setupServer.send(200,"application/json",body);
  });
  setupServer.onNotFound([](){setupServer.sendHeader("Location","/");setupServer.send(302,"text/plain","");});
  setupServer.begin();
  Serial.println("Portal pengaturan Wi-Fi aktif.");
}
void setup(){
  Serial.begin(115200);
  Serial.setTimeout(100);
  Serial.printf("\nWastafel Pintar firmware %s\n",FIRMWARE_VERSION);
  Serial.printf("Kapasitas antrean event: %u\n",MAX_PENDING_EVENTS);
  usagePreferences.begin("wastafel-count",false);
  soapCount=usagePreferences.getUInt("soapCount",0);
  waterCount=usagePreferences.getUInt("waterCount",0);
  usageCountersInitialized=usagePreferences.getBool("initialized",false);
  levelPreferences.begin("wastafel-level",false);
  for(int i=0;i<6;i++){char key[4];snprintf(key,sizeof(key),"d%d",i);levelCalibrationCm[i]=levelPreferences.getFloat(key,0);}
  Serial.printf("Hitungan tersimpan: sabun=%lu air=%lu\n",(unsigned long)soapCount,(unsigned long)waterCount);
  tampilkanTitikKalibrasi();
  pinMode(IR_SABUN,INPUT_PULLUP);pinMode(IR_AIR,INPUT_PULLUP);pinMode(TRIG_PIN,OUTPUT);pinMode(ECHO_PIN,INPUT);pinMode(FLOW_PIN,INPUT_PULLUP);
  rawSabunTerakhir=digitalRead(IR_SABUN); rawAirTerakhir=digitalRead(IR_AIR);
  rawSabunBerubahPada=millis(); rawAirBerubahPada=millis();
  digitalWrite(RELAY_SABUN,RELAY_AKTIF_LOW?HIGH:LOW);digitalWrite(RELAY_AIR,RELAY_AKTIF_LOW?HIGH:LOW);pinMode(RELAY_SABUN,OUTPUT);pinMode(RELAY_AIR,OUTPUT);aturRelay(RELAY_SABUN,false);aturRelay(RELAY_AIR,false);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN),hitungPulsaFlow,FALLING);
  bootId=String((uint32_t)esp_random(),HEX);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  wifiPreferences.begin("wastafel-wifi",true);
  String savedSsid=wifiPreferences.getString("ssid",WIFI_SSID);
  String savedPassword=wifiPreferences.getString("password",WIFI_PASSWORD);
  wifiPreferences.end();
  WiFi.begin(savedSsid.c_str(),savedPassword.c_str());
  Serial.printf("Menghubungkan Wi-Fi ke SSID: %s\n",savedSsid.c_str());
  unsigned long start=millis();
  while(WiFi.status()!=WL_CONNECTED&&millis()-start<20000){delay(500);Serial.print(".");}
  Serial.println();
  wifiWasConnected=WiFi.status()==WL_CONNECTED;
  if(WiFi.status()==WL_CONNECTED){
    Serial.printf("Wi-Fi tersambung. IP ESP32: %s\n",WiFi.localIP().toString().c_str());
    configTime(7*3600,0,"pool.ntp.org","time.google.com");
    loginFirebase();
    inisialisasiHitunganDariFirebase();
  }else{
    Serial.printf("Wi-Fi belum tersambung setelah 20 detik (status=%d). Akan mencoba ulang otomatis.\n",WiFi.status());
    mulaiPortalWiFi();
  }
  lastWifiRetry=millis();
}
void loop(){
  if(setupPortalActive)setupServer.handleClient();
  bool wifiConnectedNow=WiFi.status()==WL_CONNECTED;
  if(wifiConnectedNow&&!wifiWasConnected){
    Serial.printf("Wi-Fi tersambung kembali. IP ESP32: %s\n",WiFi.localIP().toString().c_str());
  }else if(!wifiConnectedNow&&wifiWasConnected){
    Serial.printf("Wi-Fi terputus (status=%d). Menunggu auto-reconnect.\n",WiFi.status());
  }
  wifiWasConnected=wifiConnectedNow;
  if(!wifiConnectedNow&&millis()-lastWifiRetry>=WIFI_RETRY_INTERVAL_MS){
    lastWifiRetry=millis();
    bool retryStarted=WiFi.reconnect();
    Serial.printf("Retry Wi-Fi tanpa mengubah konfigurasi: %s (status=%d)\n",retryStarted?"diminta":"belum berhasil diminta",WiFi.status());
  }
  kontrolDispenser();
  prosesPerintahSerial();
  bool pompaSedangAktif=pompaSabunON||pompaAirON;
  bool kirimPerubahan=statusNeedsPush&&wifiConnectedNow&&millis()-lastPush>=1000;
  bool kirimHeartbeat=!pompaSedangAktif&&millis()-lastPush>=5000;
  if(kirimPerubahan||kirimHeartbeat){
    lastPush=millis();
    perbaruiLevel();
    if(WiFi.status()==WL_CONNECTED){
      // Saat pompa aktif, kirim status ON/OFF saja agar dashboard langsung
      // berubah. Sinkronisasi riwayat menunggu pompa berhenti.
      if(!pompaSedangAktif){
        inisialisasiHitunganDariFirebase();
        kirimEventTertunda();
      }
      if(kirimStatus())statusNeedsPush=false;
    }else{
      Serial.printf("Data Firebase belum terkirim: Wi-Fi belum tersambung (status=%d); menunggu auto-reconnect, antrean=%u\n",WiFi.status(),pendingEventCount);
    }
  }
  if(millis()-lastDebug>=500){
    lastDebug=millis();
    unsigned long flowTotal=bacaTotalPulsa();
    unsigned long flowSesi=tanganAir?(flowTotal-pulsaAwalSesi):pulsaSesiTerakhir;
    Serial.printf("DEBUG rawSabun=%d rawAir=%d | sensorSabun=%s sensorAir=%s | pompaSabun=%s pompaAir=%s | hitungSabun=%lu hitungAir=%lu | flowPin18=%d flowTotal=%lu flowSesi=%lu volume=%.1fmL | jarakGalon=%.1fcm sisa=%.2fL valid=%s | timeoutSabun=%s | eventMenunggu=%u\n",digitalRead(IR_SABUN),digitalRead(IR_AIR),tanganSabun?"DETEKSI":"TIDAK",tanganAir?"DETEKSI":"TIDAK",pompaSabunON?"ON":"OFF",pompaAirON?"ON":"OFF",(unsigned long)soapCount,(unsigned long)waterCount,digitalRead(FLOW_PIN),(unsigned long)flowTotal,(unsigned long)flowSesi,volumeAirML,jarakCM,sisaAirML/1000.0,levelValid?"YA":"TIDAK",sabunTimeout?"YA":"TIDAK",pendingEventCount);
  }
  delay(20);
}


