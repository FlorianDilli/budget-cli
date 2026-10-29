// Registers the service worker in production builds only. The worker precaches the
// app shell; it never caches uploads, decrypted data, or backups (Decision 12).
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // Vite hashes the entry script; changing it also triggers a worker update.
    const assets = Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[type="module"][src], link[rel="stylesheet"][href]'))
      .map((element) => element instanceof HTMLScriptElement ? element.src : element.href).join('|');
    const url = `${import.meta.env.BASE_URL}sw.js?v=${encodeURIComponent(assets)}`;
    navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL }).then((registration) => {
      let accepted = false;
      const offerUpdate = () => {
        if (registration.waiting && navigator.serviceWorker.controller && window.confirm('A new version is ready. Reload now? Unsaved edits will be lost.')) {
          accepted = true;
          registration.waiting.postMessage('SKIP_WAITING');
        }
      };
      offerUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') offerUpdate();
        });
      });
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (accepted && !refreshing && navigator.serviceWorker.controller) {
          refreshing = true;
          window.location.reload();
        }
      });
    }).catch(() => {
      // Offline support is optional; the app works without it.
    });
  });
}
