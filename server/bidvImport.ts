/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { ExpenseCategory, TransactionType, type BidvImportReview, type PendingBidvImport } from "../src/types.js";
import { INCOME_CATEGORIES } from "../src/utils/incomeCategories.js";

export interface BidvEventInput {
  eventId: string;
  receivedAt: string;
  title: string;
  body: string;
}

const EVENT_FIELDS = ["eventId", "receivedAt", "title", "body"] as const;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
const INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function normalizeTimestamp(value: string): string | null {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || match[0] !== value) return null;

  const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
  const monthNumber = Number(month);
  const offsetMinutes = Number(offsetHour) * 60 + Number(offsetMinute);
  if (Number(year) < 1900 || monthNumber < 1 || monthNumber > 12 ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      Number(offsetMinute) > 59 || offsetMinutes > 14 * 60) {
    return null;
  }

  const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  if (Number(day) < 1 || Number(day) > daysInMonth) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

type BidvEventParseResult =
  | { event: BidvEventInput }
  | { error: string; fields?: readonly (keyof BidvEventInput)[] };

export function parseBidvEvent(value: unknown): BidvEventParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Nội dung yêu cầu phải là một đối tượng JSON." };
  }
  const missing = EVENT_FIELDS.filter(field => !Object.hasOwn(value, field));
  if (missing.length) {
    return { error: "Phím tắt chưa gửi đủ các trường JSON. Kiểm tra tên trường và biến đã chọn.", fields: missing };
  }
  if (Object.keys(value).length !== EVENT_FIELDS.length) {
    return { error: "JSON chỉ nhận bốn trường eventId, receivedAt, title và body." };
  }

  const { eventId, receivedAt, title, body } = value as Record<string, unknown>;
  if (typeof eventId !== "string" || !eventId || eventId.length > 100 || /[^A-Za-z0-9_-]/.test(eventId)) {
    return { error: "eventId phải là văn bản và chỉ chứa chữ cái ASCII, số, dấu gạch ngang hoặc gạch dưới.", fields: ["eventId"] };
  }
  const timestamp = typeof receivedAt === "string" && normalizeTimestamp(receivedAt);
  if (!timestamp) {
    return { error: "receivedAt cần ngày giờ ISO 8601 có múi giờ, ví dụ 2026-11-27T09:52:00+07:00.", fields: ["receivedAt"] };
  }
  if (typeof title !== "string" || title.length > 160 || INVALID_TEXT.test(title)) {
    return { error: "title phải là văn bản hợp lệ, tối đa 160 ký tự.", fields: ["title"] };
  }
  if (typeof body !== "string" || body.length > 3000 || INVALID_TEXT.test(body)) {
    return { error: "body phải là văn bản hợp lệ, tối đa 3000 ký tự.", fields: ["body"] };
  }
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!cleanTitle && !cleanBody) {
    return { error: "Title và Body đều trống. Hãy để thông báo SmartBanking mới kích hoạt tự động hóa.", fields: ["title", "body"] };
  }
  return { event: { eventId, receivedAt: timestamp, title: cleanTitle, body: cleanBody } };
}

export function parseBidvReview(value: unknown): BidvImportReview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { action, type, amount, date, category, description, rememberCategory, autoApprove } = value as Record<string, unknown>;
  if (action === "dismiss") return { action };
  if ((action !== "approve" && action !== "transfer") ||
      (type !== TransactionType.INCOME && type !== TransactionType.EXPENSE) ||
      typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 ||
      typeof date !== "string" || date.length !== 10 || !normalizeTimestamp(date + "T00:00:00Z") ||
      typeof description !== "string" || !description.trim() || description.length > 250 || INVALID_TEXT.test(description)) {
    return null;
  }
  const fields = { type, amount, date, description: description.trim() };
  if (action === "transfer") return autoApprove === undefined ? { action, ...fields } : null;

  if (typeof category !== "string" || category.length > 100 || INVALID_TEXT.test(category) ||
      (rememberCategory !== undefined && typeof rememberCategory !== "boolean") ||
      (autoApprove !== undefined && typeof autoApprove !== "boolean") ||
      ((rememberCategory === true || autoApprove === true) && !category.trim())) {
    return null;
  }

  return { action, ...fields, category: category.trim() || ExpenseCategory.OTHER,
    ...(rememberCategory === true && { rememberCategory: true }),
    ...(autoApprove === true && { autoApprove: true }) };
}

const FIELD_LABEL = /(?:^|[\s;|])(Số tiền GD|Nội dung(?: GD| giao dịch| chuyển khoản)?|ND(?: GD)?|Thời gian(?: GD| giao dịch)?|Ngày(?: giờ)?(?: GD| giao dịch)?|Số dư(?: khả dụng| hiện tại| cuối)?|Số (?:TK|tài khoản)|TK|Tài khoản(?: thanh toán)?|Mã (?:GD|giao dịch|tham chiếu)|Số tham chiếu|Ref(?:erence)?)[ \t]*:/giu;
const SIGNED_AMOUNT = /^([+\-−])\s*(\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+|\d+)\s*(?:VND|VNĐ|₫|đ)$/iu;
const COUNTERPARTY_PREFIX = /^(?:[A-Z][A-Z0-9]{1,19}-[ \t]*)?TKThe[ \t]*:?[ \t]*(\d{6,20})(?:_[\p{L}\p{M} ]{1,100})?[ \t]*,?[ \t]+t(?:ai|ại)[ \t]+([A-Z][A-Z0-9]{1,19})(?=\s*[.,;|]|$)/iu;
const TRANSFER_REFERENCE = /\s+-?\s*CTLNHI(?:DI|DO)\d{10,24}(?:-[A-Z0-9/]{1,24})*-?$/i;
const VIRTUAL_ACCOUNT_PREFIX = /^@VA[\p{L}\p{M}\d_ ]{1,120}\/\d{6,20}_/iu;
const COLLECTION_PREFIX = /^[A-Z][A-Z0-9]{1,19}_[\p{L}\p{M}_ ]{2,100}\/\d{6,20}__\d{6,20} \d{6,20} /iu;
const MOMO_MEMO = /^(?:(?:\d{6,20} ){2}[\p{L}\p{M} ]{2,100} )?chuy[eể]n ti[eề]n qua momo\.?(?:\s*[:;|]\s*(.+))?$/iu;
const GENERATED_TRANSFER = /^(?:[\p{Lu}\p{M} ]+ )?[Cc]huy[eể]n [Tt]i[eề]n(?: [dđ][eế]n [\p{Lu}\p{M} ]+ \d{6,20}(?: - [A-Z0-9_]+)?)?[.!]?$/u;
const VN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
});

function normalizedText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("vi").replace(/\s+/g, " ").trim();
}

function transactionDate(value: string): string | null {
  const match = /^(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?(?:(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})|(\d{4})-(\d{2})-(\d{2}))(?=\s|T|$)/.exec(value);
  if (!match) return null;
  const [, day, month, year, isoYear, isoMonth, isoDay] = match;
  const date = [isoYear ?? year, (isoMonth ?? month).padStart(2, "0"), (isoDay ?? day).padStart(2, "0")].join("-");
  return normalizeTimestamp(date + "T00:00:00Z") ? date : null;
}

function describeBidvTransfer(type: TransactionType | "", memo: string): string {
  const partner = COUNTERPARTY_PREFIX.exec(memo);
  const content = (partner ? memo.slice(partner[0].length).replace(/^[\s.,;|]+/, "") : memo)
    .replace(TRANSFER_REFERENCE, "").trim()
    .replace(VIRTUAL_ACCOUNT_PREFIX, "")
    .replace(COLLECTION_PREFIX, "")
    .trim();
  const momo = MOMO_MEMO.exec(content);
  const bank = partner?.[2].toUpperCase();
  const channel = momo ? "MoMo" : bank || "BIDV";
  const note = momo ? momo[1] : content;
  const opaque = !note || GENERATED_TRANSFER.test(note) ||
    /^(?:@VA|(?:[A-Z][A-Z0-9]{1,19}-)?TKThe\b|\d{6,20} \d{6,20}(?: |$)|CTLNHI(?:DI|DO)\d)/i.test(note);
  if (!opaque) return note.trim().slice(0, 250).trimEnd();

  if (type === TransactionType.INCOME) return `Nhận tiền qua ${channel}`;
  if (type === TransactionType.EXPENSE) return bank && !momo ? `Chuyển tiền đến ${bank}` : `Chuyển tiền qua ${channel}`;
  return `Giao dịch ${channel}`;
}

export function readBidvNotification(body: string, receivedAt: string) {
  const text = body.normalize("NFC");
  const fields = [...text.matchAll(FIELD_LABEL)];
  const amounts: string[] = [];
  let memo = "";
  let date: string | null = null;

  fields.forEach((field, index) => {
    const label = normalizedText(field[1]);
    const value = text.slice(field.index + field[0].length, fields[index + 1]?.index).trim();
    if (label === "số tiền gd") amounts.push(value.split(/\r?\n/, 1)[0].replace(/[;|]+\s*$/, "").trim());
    if (/^(?:nội dung|nd)(?: |$)/.test(label) && !memo) memo = value.replace(/[;|]+\s*$/, "").replace(/\s+/g, " ").trim();
    if (/^(?:thời gian|ngày)(?: |$)/.test(label) && !date) date = transactionDate(value);
  });

  const signed = amounts.length === 1 ? SIGNED_AMOUNT.exec(amounts[0]) : null;
  const amount = signed ? Number(signed[2].replace(/[,.]/g, "")) : null;
  const validAmount = amount !== null && Number.isSafeInteger(amount) && amount > 0;
  const type = validAmount && signed
    ? (signed[1] === "+" ? TransactionType.INCOME : TransactionType.EXPENSE)
    : "";

  const received = new Date(receivedAt);
  const parts = Number.isNaN(received.getTime()) ? null : Object.fromEntries(
    VN_DATE.formatToParts(received).map(part => [part.type, part.value]),
  );
  return {
    type,
    amount: validAmount ? amount : null,
    date: date ?? (parts ? [parts.year, parts.month, parts.day].join("-") : ""),
    description: describeBidvTransfer(type, memo),
    memo,
  } satisfies Omit<PendingBidvImport["suggestion"], "category"> & { memo: string };
}

// SmartBanking puts the counterparty inside the memo, separately from Tài khoản thanh toán.
export function identifyBidvCounterparty(type: TransactionType | "", memo: string) {
  if (!type || [...memo.matchAll(/\bTKThe\b/gi)].length !== 1) return null;
  const match = COUNTERPARTY_PREFIX.exec(memo);
  if (!match) return null;
  const [, account, bankName] = match;
  const bank = bankName.toUpperCase();
  const id = createHash("sha256").update(JSON.stringify([type, bank, account])).digest("hex");
  return { id, bank, accountEnding: account.slice(-4) };
}

export function bidvCategoryRuleId(type: TransactionType, memo: string): string | null {
  const normalizedMemo = normalizedText(memo);
  if (!normalizedMemo) return null;
  return createHash("sha256").update(type + "\n" + normalizedMemo).digest("hex");
}

const EXPENSE_HINTS = [
  { category: ExpenseCategory.UTILITIES, pattern: /\b(?:tien dien|tien nuoc|hoa don dien|hoa don nuoc)\b/ },
  { category: ExpenseCategory.EDUCATION, pattern: /\b(?:dong hoc phi|nop hoc phi|thanh toan hoc phi)\b/ },
  { category: ExpenseCategory.TRANSPORT, pattern: /\b(?:do xang|tien xang|phi gui xe)\b/ },
];

export function suggestBidvCategory(type: TransactionType | "", memo: string): string {
  const text = normalizedText(memo).normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
  if (type === TransactionType.INCOME) {
    return /\b(?:tra luong|nhan luong|luong thang)\b/.test(text) ? INCOME_CATEGORIES[0] : "";
  }
  if (type !== TransactionType.EXPENSE) return "";
  const matches = EXPENSE_HINTS.filter(({ pattern }) => pattern.test(text));
  return matches.length === 1 ? matches[0].category : "";
}

export function isBidvImportToken(authorization: string | undefined, secret: string): boolean {
  const match = authorization && /^Bearer +(\S+)$/i.exec(authorization);
  if (!match || !secret) return false;

  const supplied = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(supplied, expected);
}
