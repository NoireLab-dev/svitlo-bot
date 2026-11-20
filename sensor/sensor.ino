// Датчик світла й напруги для бота svitlo-bot: ESP32 + PZEM-004T v4 у звичайній розетці квартири.
// Раз на секунду міряє напругу. Пропала напруга (PZEM живиться від мережі і замовкає) = світла немає.
// Раз на хвилину кладе знімок у змінну репозиторію SENSOR, а на подіях ще й будить бота (workflow_dispatch).
// Плата і роутер живляться від ДБЖ, тому під час відключення датчик на зв'язку.
// Дроти: PZEM 5V -> 3V3 (рівні 3.3 В, GPIO ESP32 не терплять 5 В), GND -> GND, PZEM TX -> GPIO16, PZEM RX -> GPIO17.
// Якщо PZEM на 3.3 В не відповідає - живлення на VIN (5 В). Котушка струму не потрібна: міряємо лише напругу.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PZEM004Tv30.h>
#include <time.h>
#include "secrets.h" // WIFI_SSID, WIFI_PASS, GH_TOKEN (не в git, шаблон secrets.example.h)
#include "certs.h"

const char* API = "https://api.github.com/repos/NoireLab-dev/svitlo-bot";
const float LO = 207, HI = 253; // 230 В ±10%

PZEM004Tv30 pzem(Serial2, 16, 17);

// епізоди в секундах аптайму; у JSON переводимо в unix-час, коли NTP вже дав годинник
struct Ep { uint32_t s, e; uint16_t pk; };
const int N = 8;
Ep outs[N], xs[N];
int nOut = 0, nX = 0;
void push(Ep* a, int& n, Ep v) { if (n == N) { memmove(a, a + 1, sizeof(Ep) * (N - 1)); n--; } a[n++] = v; }

uint32_t up() { return esp_timer_get_time() / 1000000ULL; }
uint32_t base = 0; // unix-час у момент старту плати

bool on = true, inX = false, x60 = false, kick = false, dirty = true;
int offCnt = 0, onCnt = 0, badCnt = 0, goodCnt = 0;
float v = 0, recent[5] = {0};
int ri = 0;
uint32_t lastOut = 0, lastPatch = 0, lastDispatch = 0, lastOk = 0, lastSample = 0;

void endX(uint32_t t) {
  Ep& x = xs[nX - 1];
  x.e = t; inX = false; badCnt = goodCnt = 0; dirty = true;
  if (t - x.s >= 60 || x.pk >= 260 || x.pk <= 190) kick = true;
}

void sample() {
  float r = pzem.voltage();
  bool live = !isnan(r) && r > 100;
  v = live ? r : 0;
  if (live) recent[ri++ % 5] = r;

  // світло: два однакові виміри поспіль, щоб не смикатись від одного збою зв'язку з PZEM
  if (on && !live && ++offCnt >= 2) {
    float pk = 0;
    for (float f : recent) pk = max(pk, f); // стрибок за секунди до зникнення = спрацювало реле захисту
    if (inX) endX(up() - 2);
    on = false; onCnt = 0; kick = dirty = true;
    push(outs, nOut, {up() - 2, 0, (uint16_t)pk});
  } else if (live) offCnt = 0;
  if (!on && live && ++onCnt >= 2) {
    on = true; offCnt = 0; kick = dirty = true;
    if (nOut && !outs[nOut - 1].e) outs[nOut - 1].e = up() - 2;
    memset(recent, 0, sizeof recent);
  } else if (!live) onCnt = 0;
  if (!on || !live) return;

  // напруга поза нормою: початок після 3 с поспіль, кінець після 60 с у нормі
  bool bad = r > HI || r < LO;
  if (bad) {
    goodCnt = 0; lastOut = up();
    if (!inX && ++badCnt >= 3) { inX = true; x60 = false; dirty = true; push(xs, nX, {up() - 2, 0, (uint16_t)r}); }
    if (inX) {
      Ep& x = xs[nX - 1];
      if (x.pk > HI ? r > x.pk : r < x.pk) x.pk = r;
      if (!x60 && up() - x.s >= 60) { x60 = true; kick = true; }
    }
  } else {
    badCnt = 0;
    if (inX && ++goodCnt >= 60) endX(lastOut);
  }
}

String eps(Ep* a, int n) {
  String j = "[";
  for (int i = 0; i < n; i++) j += String(i ? "," : "") + "[" + (a[i].s + base) + "," + (a[i].e ? a[i].e + base : 0) + "," + a[i].pk + "]";
  return j + "]";
}

String snapshot() {
  return String("{\"t\":") + (base + up()) + ",\"up\":" + up() + ",\"on\":" + (on ? 1 : 0) + ",\"v\":" + String(v, 1) +
         ",\"p\":" + eps(outs, nOut) + ",\"x\":" + eps(xs, nX) + "}";
}

int gh(const char* method, const String& path, const String& body) {
  WiFiClientSecure c;
  c.setCACert(ROOT_CA);
  HTTPClient h;
  h.setTimeout(15000);
  if (!h.begin(c, String(API) + path)) return -1;
  h.addHeader("Authorization", String("Bearer ") + GH_TOKEN);
  h.addHeader("Accept", "application/vnd.github+json");
  h.addHeader("User-Agent", "svitlo-sensor");
  h.addHeader("Content-Type", "application/json");
  int code = h.sendRequest(method, body);
  if (code >= 300 || code < 0) Serial.printf("%s %s -> %d %s\n", method, path.c_str(), code, h.getString().c_str());
  h.end();
  return code;
}

void report() {
  lastPatch = up(); // і при помилці: наступна спроба не раніше ніж за 10 с
  String s = snapshot();
  s.replace("\"", "\\\"");
  int code = gh("PATCH", "/actions/variables/SENSOR", "{\"name\":\"SENSOR\",\"value\":\"" + s + "\"}");
  if (code == 404) code = gh("POST", "/actions/variables", "{\"name\":\"SENSOR\",\"value\":\"" + s + "\"}"); // першого разу змінної ще немає
  if (code < 200 || code >= 300) return;
  lastOk = up(); dirty = false;
  // будимо бота не частіше ніж раз на 90 с: черга GitHub однаково тримає лише один запуск
  if (kick && up() - lastDispatch >= 90) {
    int d = gh("POST", "/actions/workflows/monitor.yml/dispatches", "{\"ref\":\"main\"}");
    if (d == 204) { kick = false; lastDispatch = up(); }
  }
  Serial.printf("звіт: %s%s\n", snapshot().c_str(), kick ? " (бота розбуджу пізніше)" : "");
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.println("\nдатчик svitlo: старт");
}

void loop() {
  if (up() - lastSample >= 1) { lastSample = up(); sample(); }
  if (!base) { time_t t = time(nullptr); if (t > 1700000000) { base = t - up(); Serial.println("час є"); } }
  static uint32_t lastLog = 0;
  if (up() - lastLog >= 5) { lastLog = up(); Serial.printf("V=%.1f світло=%d wifi=%d\n", v, on, WiFi.status() == WL_CONNECTED); }

  if (WiFi.status() == WL_CONNECTED && base && (up() - lastPatch >= 60 || ((kick || dirty) && up() - lastPatch >= 10))) report();
  // 30 хв без жодного вдалого звіту - перезапуск (Wi-Fi чи TLS могли зависнути)
  if (up() - lastOk > 1800) ESP.restart();
  delay(20);
}
