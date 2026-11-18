// Importé en premier : toute erreur JS non rattrapée s'affiche au lieu de laisser l'UI à moitié chargée.
function show(msg: string) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = `Erreur : ${msg}`;
  t.hidden = false;
}
window.addEventListener("error", (e) => show(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => show(String((e as PromiseRejectionEvent).reason)));
