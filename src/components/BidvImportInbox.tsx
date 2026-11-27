/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Inbox, RefreshCw, X } from "lucide-react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { BANK_IMPORT_LABELS, bankImportSource, TransactionType, type BankImportSource, type PendingBidvImport, type BidvImportReview, type BidvAutoApprovalRule } from "../types.js";
import { INCOME_CATEGORIES, INCOME_CUSTOM, isPresetIncome } from "../utils/incomeCategories.js";
import { useModalA11y } from "../hooks/useModalA11y.js";
import { DateInputDMY, dateVNToIso } from "./DateTimePicker24.js";
import { MoneyInput } from "./MoneyInput.js";
import { useConfirm } from "./ConfirmDialog.js";
import { FancySelect, type SelectOption } from "./FancySelect.js";

const INPUT_CLASS = "w-full min-w-0 bg-slate-950 neu-pressed-sm rounded-xl px-3 py-2.5 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500";
const RECEIVED_TIME = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const IMPORT_AMOUNT = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" });
const BUTTON_CLASS = "min-h-10 rounded-xl px-3 py-2 font-semibold cursor-pointer disabled:cursor-default disabled:opacity-60";

interface ReviewDraft {
  id: string;
  type: TransactionType | "";
  amount: number;
  date: string;
  category: string;
  description: string;
  customIncome: boolean;
  detectedType: TransactionType | "";
  canAutoApprove: boolean;
  autoApprove: boolean;
  reuseDescription: boolean;
  internalTransfer: boolean;
}

interface InboxProps {
  source: BankImportSource;
  authToken: string;
  expenseCategories: SelectOption[];
  onApproved: () => Promise<void>;
  revision: number;
  reviewRequest: { id: string; seq: number } | null;
  onReviewOpened: (seq: number) => void;
}

export function BankImportInbox({ source, authToken, expenseCategories, onApproved, revision, reviewRequest, onReviewOpened }: InboxProps) {
  const { t } = useTranslation();
  const api = `/api/finance/imports/${source}`;
  const bank = BANK_IMPORT_LABELS[source];
  const label = source === "bidv" ? t("finance.bidvInbox.title") : bank;
  const inboxText = (key: string) => t("finance.bidvInbox." + key, { bank });
  const [items, setItems] = useState<PendingBidvImport[]>([]);
  const [receivingEnabled, setReceivingEnabled] = useState<boolean | null>(null);
  const [rules, setRules] = useState<BidvAutoApprovalRule[]>([]);
  const [tab, setTab] = useState<"pending" | "rules">("pending");
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const handledReview = useRef(0);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const activeItem = draft ? items.find(item => item.id === draft.id) : undefined;
  const closeReview = useCallback(() => {
    if (savingRef.current) return;
    setDraft(null);
    setError("");
  }, []);
  useModalA11y(Boolean(draft && activeItem), closeReview, dialogRef);
  const { confirm, ConfirmDialog } = useConfirm();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    async function loadPending() {
      try {
        const response = await fetch(api + "/pending", {
          headers: { Authorization: "Bearer " + authToken },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("BIDV inbox unavailable");
        const { imports, rules, receivingEnabled } = await response.json() as {
          imports: PendingBidvImport[];
          rules: BidvAutoApprovalRule[];
          receivingEnabled: boolean;
        };
        if (controller.signal.aborted) return;
        setItems(imports);
        setRules(rules);
        setError(current => current === "loadError" ? "" : current);
        setReceivingEnabled(receivingEnabled);
        setDraft(current => current && imports.some(item => item.id === current.id) ? current : null);
      } catch {
        if (!controller.signal.aborted) {
          setError("loadError");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadPending();
    return () => controller.abort();
  }, [api, authToken, refresh, revision]);

  const incomeOptions = [
    ...INCOME_CATEGORIES.map(category => ({ value: category, label: category })),
    { value: INCOME_CUSTOM, label: t("finance.formCatOther") },
  ];

  function fallbackDescription(type: ReviewDraft["type"]) {
    if (type === TransactionType.INCOME) return inboxText("incomingDescription");
    if (type === TransactionType.EXPENSE) return inboxText("outgoingDescription");
    return inboxText("defaultDescription");
  }

  function openReview(item: PendingBidvImport) {
    setError("");
    setNotice("");
    const { type, amount, date, description } = item.suggestion;
    const suggested = item.suggestion.category;
    const category = type !== TransactionType.EXPENSE || expenseCategories.some(option => option.value === suggested)
      ? suggested : "";
    setDraft({
      id: item.id, type, amount: amount ?? 0, date, category,
      description: description || fallbackDescription(type),
      customIncome: type === TransactionType.INCOME && Boolean(category) && !isPresetIncome(category),
      detectedType: type, canAutoApprove: Boolean(item.counterparty), autoApprove: false, reuseDescription: false, internalTransfer: false,
    });
  }

  function changeDirection(type: TransactionType) {
    if (!draft) return;
    setDraft({
      ...draft, type, category: "", customIncome: false, autoApprove: false, reuseDescription: false,
      description: draft.description === fallbackDescription(draft.type) ? fallbackDescription(type) : draft.description,
    });
  }

  async function submitReview(id: string, review: BidvImportReview) {
    if (savingRef.current || loading) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(api + "/" + encodeURIComponent(id) + "/review", {
        method: "POST",
        headers: { Authorization: "Bearer " + authToken, "Content-Type": "application/json" },
        body: JSON.stringify(review),
      });
      if (response.status === 404 || response.status === 409) {
        setError("alreadyReviewed");
        setRefresh(value => value + 1);
        return;
      }
      if (!response.ok) {
        setError(response.status === 400 ? "invalidReview" : "saveError");
        return;
      }

      setItems(current => current.filter(item => item.id !== id));
      setDraft(current => current?.id === id ? null : current);
      const noticeByAction = { approve: "recorded", transfer: "transferRecorded", dismiss: "dismissed" };
      setNotice(noticeByAction[review.action]);
      if (review.action === "approve") {
        if (review.autoApprove) setRefresh(value => value + 1);
        await onApproved();
      }
    } catch {
      setError("saveError");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const { amount } = draft;
    const date = dateVNToIso(String(new FormData(event.currentTarget).get("date") ?? ""));
    if (!draft.type || !Number.isSafeInteger(amount) || amount <= 0 ||
        !date || date < "1900-01-01" || !draft.description.trim() ||
        (!draft.internalTransfer && (!draft.category.trim() ||
          (draft.type === TransactionType.EXPENSE && !expenseCategories.some(option => option.value === draft.category))))) {
      setError("invalidReview");
      return;
    }
    const { type, category, description, autoApprove, reuseDescription, internalTransfer } = draft;
    const fields = { type, amount, date, description };
    const review: BidvImportReview = internalTransfer
      ? { action: "transfer", ...fields }
      : { action: "approve", ...fields, category,
          ...(autoApprove && { autoApprove: true, ...(reuseDescription && { reuseDescription: true }) }) };
    void submitReview(draft.id, review);
  }

  async function dismiss(id: string) {
    if (await confirm({ title: t("finance.bidvInbox.dismiss"), message: t("finance.bidvInbox.dismissConfirm") })) {
      await submitReview(id, { action: "dismiss" });
    }
  }

  async function toggleRule(rule: BidvAutoApprovalRule) {
    if (savingRef.current || loading) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(api + "/rules/" + encodeURIComponent(rule.id), {
        method: "PATCH",
        headers: { Authorization: "Bearer " + authToken, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!response.ok) throw new Error("BIDV rule update failed");
      setRules(current => current.map(item => item.id === rule.id ? { ...item, enabled: !rule.enabled } : item));
      setRefresh(value => value + 1);
    } catch {
      setError("saveError");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!reviewRequest || bankImportSource(reviewRequest.id) !== source || loading || handledReview.current === reviewRequest.seq) return;
    handledReview.current = reviewRequest.seq;
    setTab("pending");
    const item = items.find(item => item.id === reviewRequest.id);
    if (item) openReview(item);
    else requestAnimationFrame(() => document.getElementById(source + "-inbox")?.scrollIntoView({ block: "start" }));
    onReviewOpened(reviewRequest.seq);
  }, [reviewRequest, loading, items, onReviewOpened, source]);

  if (!receivingEnabled && items.length === 0 && rules.length === 0 && !error && !notice) return null;

  return (
    <section id={source + "-inbox"} aria-labelledby={source + "-inbox-title"} className="bg-slate-900 neu-raised rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id={source + "-inbox-title"} className="flex items-center gap-2 text-sm font-bold text-slate-200">
          <Inbox aria-hidden="true" className="w-4 h-4 text-sky-400" />
          {label}
        </h3>
        <button type="button" disabled={loading || saving}
          aria-label={inboxText("refresh")} title={inboxText("refresh")}
          className="p-2 rounded-lg bg-slate-950 neu-btn text-slate-400 hover:text-sky-400 cursor-pointer disabled:opacity-60"
          onClick={() => { setError(""); setNotice(""); setRefresh(value => value + 1); }}>
          <RefreshCw aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>

      {source === "bidv" && <div role="group" aria-label={label} className="flex gap-1 rounded-xl bg-slate-950/40 neu-pressed-sm p-1 text-xs">
        <button type="button" aria-pressed={tab === "pending"}
          className={BUTTON_CLASS + " flex-1 " + (tab === "pending" ? "bg-slate-900 neu-raised-sm text-sky-400" : "text-slate-400")}
          onClick={() => { setTab("pending"); setError(""); setNotice(""); }}>
          {t("finance.bidvInbox.pendingTab")} {items.length > 0 && <span className="font-mono">({items.length})</span>}
        </button>
        <button type="button" aria-pressed={tab === "rules"}
          className={BUTTON_CLASS + " flex-1 " + (tab === "rules" ? "bg-slate-900 neu-raised-sm text-sky-400" : "text-slate-400")}
          onClick={() => { setTab("rules"); setDraft(null); setError(""); setNotice(""); }}>
          {t("finance.bidvInbox.rulesTab")}
        </button>
      </div>}

      {error && !draft && <p role="alert" className="text-xs text-rose-400">{inboxText(error)}</p>}
      {notice && <p role="status" className="text-xs text-emerald-400">{inboxText(notice)}</p>}
      {loading && <p role="status" className="text-xs text-slate-400">{inboxText("loading")}</p>}

      <div className="max-h-[60dvh] overflow-y-auto overscroll-contain scrollbar-thin space-y-3 p-1">
        {tab === "rules" ? (
          <>
            {!loading && !error && rules.length === 0 && <p className="text-xs text-slate-400">{t("finance.bidvInbox.noRules")}</p>}
            {rules.map(rule => (
              <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-950/40 neu-pressed-sm p-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-bold text-slate-200">{rule.bank} <span className="font-mono">•••• {rule.accountEnding}</span></p>
                  <p className="break-words text-xs text-slate-400">
                    {t(rule.type === TransactionType.INCOME ? "finance.formIncomeBtn" : "finance.formExpenseBtn")}
                    {" · "}
                    {rule.type === TransactionType.EXPENSE
                      ? expenseCategories.find(option => option.value === rule.category)?.label ?? t("finance.bidvInbox.unavailableCategory")
                      : rule.category}
                  </p>
                  {rule.description && (
                    <p className="break-words text-xs text-slate-400">
                      {t("finance.bidvInbox.savedDescription", { description: rule.description })}
                    </p>
                  )}
                </div>
                <label className="flex items-center gap-2 min-h-10 text-xs text-slate-300">
                  <input type="checkbox" role="switch" checked={rule.enabled} disabled={loading || saving}
                    aria-label={t("finance.bidvInbox.ruleSwitch", { bank: rule.bank, ending: rule.accountEnding })}
                    className="size-4 accent-sky-500" onChange={() => void toggleRule(rule)} />
                  {t(rule.enabled ? "finance.bidvInbox.ruleOn" : "finance.bidvInbox.ruleOff")}
                </label>
              </div>
            ))}
          </>
        ) : (
          <>
            {!loading && !error && items.length === 0 && <p className="text-xs text-slate-400">{t("finance.bidvInbox.empty")}</p>}
            {items.map(item => (
              <div key={item.id} id={source + "-item-" + item.id} className="bg-slate-950/40 neu-pressed-sm rounded-xl p-3 space-y-3">
                <div className="space-y-1">
                  <time dateTime={item.receivedAt} className="block text-xs text-slate-450 font-mono">
                    {RECEIVED_TIME.format(new Date(item.receivedAt))}
                  </time>
                  <p className="font-semibold text-sm text-slate-200 break-words line-clamp-2">
                    {item.suggestion.description || fallbackDescription(item.suggestion.type)}
                  </p>
                  {item.suggestion.amount !== null && (
                    <p className="text-xs font-mono text-slate-300">
                      {IMPORT_AMOUNT.format(item.suggestion.amount * (item.suggestion.type === TransactionType.EXPENSE ? -1 : 1))}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 justify-end text-xs">
                  <button type="button" disabled={loading || saving} onClick={() => void dismiss(item.id)}
                    className={BUTTON_CLASS + " bg-slate-800 text-slate-300 hover:bg-slate-700"}>{t("finance.bidvInbox.dismiss")}</button>
                  <button type="button" disabled={loading || saving} onClick={() => openReview(item)}
                    className={BUTTON_CLASS + " bg-sky-500/15 text-sky-400 hover:bg-sky-500/25"}>{t("finance.bidvInbox.review")}</button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {draft && activeItem && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs"
          onClick={event => { if (event.target === event.currentTarget) closeReview(); }}>
          <motion.div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={source + "-review-title"}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg max-h-[90dvh] flex flex-col overflow-hidden shadow-2xl outline-none">
            <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-slate-800 shrink-0">
              <h3 id={source + "-review-title"} className="font-bold text-slate-100">{t("finance.bidvInbox.review")} · {label}</h3>
              <button type="button" onClick={closeReview} disabled={saving} aria-label={t("finance.formClose")}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-60">
                <X aria-hidden="true" className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={approve} className="space-y-3 text-xs overflow-y-auto overscroll-contain min-h-0 px-5 py-4">
              {(activeItem.title || activeItem.body) && (
                <details className="text-xs text-slate-400">
                  <summary className="py-2 cursor-pointer">{t("finance.bidvInbox.originalNotification")}</summary>
                  {activeItem.title && <p className="font-semibold break-words">{activeItem.title}</p>}
                  {activeItem.body && <p className="whitespace-pre-wrap break-words">{activeItem.body}</p>}
                </details>
              )}
              {error && <p role="alert" className="text-xs text-rose-400">{inboxText(error)}</p>}
              <fieldset disabled={saving || loading} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <label htmlFor={source + "-review-type"} className="block text-slate-400 font-semibold">{t("finance.bidvInbox.direction")}</label>
                  <FancySelect id={source + "-review-type"} value={draft.type} ariaLabel={t("finance.bidvInbox.direction")}
                    options={[
                      { value: TransactionType.INCOME, label: t("finance.formIncomeBtn") },
                      { value: TransactionType.EXPENSE, label: t("finance.formExpenseBtn") },
                    ]}
                    onChange={type => changeDirection(type as TransactionType)} />
                </div>
                <div className="min-w-0 space-y-1">
                  <label htmlFor={source + "-review-amount"} className="block text-slate-400 font-semibold">{t("finance.formAmountLabel")}</label>
                  <MoneyInput id={source + "-review-amount"} value={draft.amount}
                    onChange={amount => setDraft({ ...draft, amount })} operators={draft.type === TransactionType.EXPENSE}
                    className={INPUT_CLASS + " font-mono"} />
                </div>
                <div className="min-w-0 space-y-1">
                  <span className="block text-slate-400 font-semibold">{t("finance.formDateLabel")}</span>
                  <DateInputDMY name="date" required min="1900-01-01" max="9999-12-31"
                    ariaLabel={t("finance.formDateLabel")} value={draft.date}
                    onChange={date => setDraft({ ...draft, date })} className={INPUT_CLASS + " font-mono"} />
                </div>
                {!draft.internalTransfer && draft.type === TransactionType.EXPENSE && (
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={source + "-review-category"} className="block text-slate-400 font-semibold">{t("finance.formCatExpenseLabel")}</label>
                    <FancySelect id={source + "-review-category"} value={draft.category} options={expenseCategories}
                      placeholder={t("finance.bidvInbox.chooseCategory")}
                      ariaLabel={t("finance.formCatExpenseLabel")} onChange={category => setDraft({ ...draft, category })} />
                  </div>
                )}
                {!draft.internalTransfer && draft.type === TransactionType.INCOME && (
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={source + "-review-income"} className="block text-slate-400 font-semibold">{t("finance.formCatIncomeLabel")}</label>
                    <FancySelect id={source + "-review-income"}
                      value={draft.customIncome ? INCOME_CUSTOM : draft.category}
                      options={incomeOptions}
                      placeholder={t("finance.bidvInbox.chooseCategory")}
                      ariaLabel={t("finance.formCatIncomeLabel")}
                      onChange={category => setDraft({ ...draft, customIncome: category === INCOME_CUSTOM,
                        category: category === INCOME_CUSTOM ? "" : category })} />
                    {draft.customIncome && (
                      <input maxLength={100} aria-label={t("finance.formCatOtherPlaceholder")}
                        placeholder={t("finance.formCatOtherPlaceholder")}
                        value={draft.category}
                        onChange={event => setDraft({ ...draft, category: event.target.value })} className={INPUT_CLASS} />
                    )}
                  </div>
                )}
                <div className="min-w-0 space-y-1">
                  <span className="block text-slate-400 font-semibold">{t("finance.formAccountLabel")}</span>
                  <p className={INPUT_CLASS}>{t("finance.formAccountBank")}</p>
                </div>
                <label className="min-w-0 space-y-1 text-slate-400 font-semibold sm:col-span-2">
                  <span className="block">{t("finance.formDescLabel")}</span>
                  <input required maxLength={250} value={draft.description}
                    onChange={event => setDraft({ ...draft, description: event.target.value })} className={INPUT_CLASS} />
                </label>
                <label className="flex items-center gap-2 min-h-10 text-slate-300 sm:col-span-2">
                  <input type="checkbox" className="size-4 accent-sky-500" checked={draft.internalTransfer}
                    onChange={event => setDraft({ ...draft, internalTransfer: event.target.checked, autoApprove: false, reuseDescription: false })} />
                  {t("finance.bidvInbox.internalTransfer")}
                </label>
                {draft.internalTransfer && (
                  <p className="text-slate-400 sm:col-span-2">{inboxText("transferHelp")}</p>
                )}
                {source === "bidv" && !draft.internalTransfer && (
                  <div className="sm:col-span-2">
                    <label className="flex items-center gap-2 min-h-10 text-slate-300">
                      <input type="checkbox" className="size-4 accent-sky-500" checked={draft.autoApprove}
                        disabled={!draft.canAutoApprove || draft.type !== draft.detectedType}
                        aria-describedby={source + "-rule-help"}
                        onChange={event => setDraft({ ...draft, autoApprove: event.target.checked, reuseDescription: false })} />
                      {t("finance.bidvInbox.allowAutoApproval")}
                    </label>
                    <p id={source + "-rule-help"} className="text-slate-400">
                      {activeItem.counterparty && draft.type === draft.detectedType
                        ? t("finance.bidvInbox.ruleHelp", { bank: activeItem.counterparty.bank, ending: activeItem.counterparty.accountEnding })
                        : t("finance.bidvInbox.ruleUnavailable")}
                    </p>
                    {draft.autoApprove && (
                      <label className="flex items-center gap-2 min-h-10 text-slate-300">
                        <input type="checkbox" className="size-4 accent-sky-500" checked={draft.reuseDescription}
                          onChange={event => setDraft({ ...draft, reuseDescription: event.target.checked })} />
                        {t("finance.bidvInbox.reuseDescription")}
                      </label>
                    )}
                  </div>
                )}
              </fieldset>
              <div className="flex flex-wrap gap-2 justify-end">
                <button type="button" disabled={saving} onClick={closeReview}
                  className={BUTTON_CLASS + " bg-slate-800 text-slate-300 hover:bg-slate-700"}>{t("finance.formClose")}</button>
                <button type="submit" disabled={loading || saving}
                  className={BUTTON_CLASS + " bg-indigo-500 text-white hover:bg-indigo-400"}>
                  {t(draft.internalTransfer ? "finance.bidvInbox.markTransfer" : "finance.bidvInbox.record")}
                </button>
              </div>
            </form>
          </motion.div>
        </div>, document.body
      )}
      {ConfirmDialog}
    </section>
  );
}
