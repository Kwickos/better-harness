// Imported first: any uncaught JS error is shown instead of leaving the UI half loaded.
import { t } from "./i18n";

function show(msg: string) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = t("Error: {msg}", { msg });
  toast.hidden = false;
}
window.addEventListener("error", (e) => show(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => show(String((e as PromiseRejectionEvent).reason)));
