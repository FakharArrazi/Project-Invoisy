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


# The page no longer announces routine results with a message, so the checks wait for the result itself.
def wait_invoice_shown(page, number):
    """A completed sale shows its invoice (under its number) in the preview."""
    page.wait_for_function("(n) => document.getElementById('invoice').textContent.includes(n)", arg=number, timeout=10000)

def wait_payment_recorded(page):
    """A payment that was recorded clears the amount box (a refused one leaves it)."""
    page.wait_for_function("document.getElementById('payAmount').value === ''", timeout=10000)

def wait_idle(page):
    """Nothing is being saved any more (the buttons that are disabled while a save runs are enabled again)."""
    page.wait_for_function("!document.getElementById('autoGrant').disabled && !document.getElementById('autoRetry').disabled", timeout=10000)
