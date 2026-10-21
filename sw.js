// 앱 화면 파일을 캐시해서 빠르게 열리고, 홈 화면 앱처럼 동작하게 한다.
// (번역은 인터넷이 필요하다. OpenAI 요청은 캐시하지 않는다.)
// 앱 파일을 수정하면 VERSION을 올려야 사용자 기기에 새 버전이 적용된다.

const VERSION = 'hyjk-v4';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/store.js',
  'js/openai.js',
  'js/lang.js',
  'js/vad.js',
  'js/export.js',
  'js/translate.js',
  'js/engines/free.js',
  'js/engines/precise.js',
  'js/engines/fast.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 네트워크 우선, 실패하면 캐시 (항상 최신 파일을 쓰되 오프라인에서도 열리게)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
