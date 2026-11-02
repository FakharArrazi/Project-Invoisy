# Supplier deposits and advance payments

Money given to a supplier **without naming an invoice** (an advance). It can be made before anything was bought and can be
larger than everything bought so far. Applying it to a purchase is a separate, traceable step.

## Records (IndexedDB, database version 5)

| Store | One record is | Linked to |
|---|---|---|
| `supplierDeposits` | a deposit (`kind: "deposit"`) or a refund received from the supplier (`kind: "refund"`), with amount, date, optional method (`cash`, `bank`, `cheque`, `other`), reference and note; `status` is `recorded` or `voided` (never deleted) | the supplier only. No invoice id. |
| `advanceAllocations` | the part of ONE deposit applied to ONE purchase; `status` is `applied` or `reversed` | deposit, purchase and supplier |

No balance is stored anywhere. Every figure is calculated from these records and the existing purchases and payments by
`Purchases.supplierSummary`, so the numbers can not drift from the history.

## The formula (one calculation everywhere)

- **Paid to supplier** = invoice payments + deposits − refunds. An allocation is *not* added: it moves money that was already
  counted when the deposit was made, so nothing is counted twice.
- **Net balance** = total confirmed purchases − paid to supplier. Positive: owed to the supplier. Zero: settled.
  Negative: prepaid (the supplier holds your money).
- **Owed** = max(0, net balance). **Available advance** = max(0, −net balance).
- **Outstanding invoices** = for each confirmed purchase: total − invoice payments − allocations applied to it.
- **Unapplied deposits** = deposits − refunds − allocations.
- These always agree: **net balance = outstanding invoices − unapplied deposits**.

A general deposit lowers the net balance but never changes an invoice's paid/unpaid status; only an allocation does.
Example: purchases 100,000 and a deposit of 150,000 give net −50,000, owed 0, available advance 50,000, unapplied deposits
150,000, and the 100,000 invoice still shows unpaid until some of the advance is applied to it.

## Workflows

- **Deposit / Advance** (supplier page, Deposits tab): supplier, amount > 0, date (not in the future), optional method,
  reference, note. The form carries one id, so a double click or a retry records the deposit once.
- **Refund received**: the same form with type "Refund received". Never more than the unapplied deposits.
- **Apply an advance**: when confirming a draft (optional amount, partial allowed) or later from an open invoice
  ("Apply advance"). Never more than the unapplied deposits or than the invoice still needs. It is taken from the oldest
  deposits first, one allocation record per deposit used. The deposit itself is not edited.
- **Release** an allocation (invoice page): the money returns to the unapplied deposits; the allocation stays as history.
- **Edit / void a deposit**: old values are kept in its history. A deposit with applied allocations can not be voided and can
  not be lowered below what was applied (release the allocations first). A deposit can not be voided while refunds depend on it.
- **Cancel a purchase** releases its allocations. **Delete a purchase** removes them with it (the question says how much comes
  back). A supplier with deposits can not be deleted.

## Persistence and backups

- Version 5 only adds two empty stores; no existing record is read or changed. Records from earlier versions simply have no deposits.
- The database refuses (inside the same transaction) to delete a deposit, to apply more than a deposit holds, to settle an invoice
  for more than its total, or to leave an allocation without a confirmed purchase or an unvoided deposit.
- Backups keep `formatVersion` 2. `supplierDeposits` and `advanceAllocations` are written only when non-empty (like
  `debtTransfers`), so a backup of data without deposits has exactly its old shape. A version of the app older than this change
  restores such a backup without the deposits, so keep using the same version when restoring.
- Restoring checks every link and that all balances reconcile before anything is replaced.

## Tests

`tests/supplier-deposits.test.js` (rules, storage, backup, upgrade 4 → 5), `tests/supplier-deposits-screens.test.js` (the screens),
and the optional real-browser check `tests/e2e/supplier_deposits_check.py`.

## Unified supplier payments and automatic allocation

Paying a supplier is one experience: the **Payments** tab of the supplier profile (the separate Deposits tab is gone).
The form either pays a named invoice (a direct payment, never above that invoice's balance) or pays the supplier
(an advance), and offers "refund received" while the supplier holds credit.

* **One payment, one record.** An advance is ONE `supplierDeposits` record in the history. Allocations (`advanceAllocations`)
  are accounting movements and are listed inside the advance they came from, never as extra payments.
* **Automatic allocation** (`settleSupplierCredit`): the supplier's unapplied credit is spread over its confirmed invoices
  that still need money, ordered by invoice date, then confirmation time, then reference; each gets `min(needed, credit left)`.
  What no invoice needs stays as credit. Drafts and cancelled purchases never take credit.
* **When it runs** (always inside the same transaction as the change that caused it): recording or editing an advance,
  confirming a purchase (after its initial payment, so cash and credit never pay the same part twice), voiding an advance
  or a direct payment, lowering a payment, cancelling or deleting a purchase. A manual "Release" of one allocation is the only
  thing that leaves credit idle next to open invoices; the supplier then shows "Apply credit", and any later trigger above also
  re-applies it.
* **Edit / void an advance**: making it smaller than what was applied, or voiding it, reverses its allocations (kept as
  history, status `reversed`) and the new amount is spread again. It is refused, changing nothing, if refunds depend on the money.
* **Payment method** is now optional on direct payments too (`method`, absent on older records).
* Invariant: net balance = outstanding invoices - unapplied credit; paid = direct payments + advances - refunds.
