import type { BankImportSource } from "../src/types.js";
import type { BidvEventInput } from "./bidvImport.js";
import { isMyVibCreditCardNotice } from "./myvibImport.js";

function plainText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
}

// Look for bank-generated transaction fields rather than amounts in advertisements.
// A malformed transaction amount must still reach manual review.
export function isBankTransactionNotice(source: BankImportSource, event: Pick<BidvEventInput, "title" | "body">): boolean {
  const body = plainText(event.body);
  const title = plainText(event.title);
  // Authentication requests and failed-payment notices are not posted money movements.
  // Only inspect the heading, so words in a real transfer memo do not exclude it.
  const nonTransactionHeading = /^(?:thong bao[:\s]+)?(?:ma (?:otp|xac thuc)\b|otp\b|giao dich (?:that bai|khong thanh cong)\b)/u;
  if (nonTransactionHeading.test(title.trim()) || nonTransactionHeading.test(body.trim())) return false;
  if (source === "bidv") return /(?:^|[\s;|])so tien gd\s*:/u.test(body);
  if (isMyVibCreditCardNotice(event.title, event.body)) return false;

  const text = title + "\n" + body;
  const accountMovement = /(?:^|[\s;|])(?:tk|tai khoan)\s*:?\s*[*•x\d-]*\d{2,}[\s:;|]*(?:[+−-]\s*\d|bien dong\b|phat sinh\b|ghi (?:no|co)\b|so tien\b)/u;
  if (accountMovement.test(text)) return true;

  // Some MyVIB layouts put just the signed amount in the title.
  return /^\s*[+−-]\s*\d[\d.,]*\s*(?:vnd|₫|d)\s*$/u.test(title) &&
    /\b(?:\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{4}-\d{2}-\d{2})\b/u.test(body);
}
