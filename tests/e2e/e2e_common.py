"""Shared by the manual browser checks."""

# The "Sale completed" dialog is modal on purpose (it waits for Print Invoice / New Sale / Later). The older checks drive
# the rest of the app straight after a sale, so they choose Later the way a person would. minor_improvements_check.py
# tests the dialog itself and does not use this.
SKIP_SALE_DIALOG = """
document.addEventListener("DOMContentLoaded", () => {
  const dialog = document.getElementById("saleDoneDialog");
  if (!dialog) return;
  new MutationObserver(() => { if (dialog.open) document.getElementById("saleDoneLater").click(); })
    .observe(dialog, { attributes: true, attributeFilter: ["open"] });
});
"""
