import { TransactionType } from "../src/types.js";
import { readSignedBankAmount, transactionDate, vietnamBankDate } from "./bidvImport.js";

const CREDIT_CARD_NOTICE = /(?:th[eẻ]\s+t[ií]n\s+d[uụ]ng|credit\s+card)/iu;
const BALANCE = /(?<!\p{L})(?:số\s+dư|balance)(?!\p{L})/iu;
const AMOUNT = /(?:^|[^\p{L}\d.,+−-])([+−-][ \t]*\d[\d.,]*[ \t]*(?:VND|VNĐ|₫|đ))(?=$|[^\p{L}\d])/giu;
const DATE = /(?<![\d/.\-])(?:\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{4}-\d{2}-\d{2})(?![\d/.\-])/g;

export function isMyVibCreditCardNotice(title: string, body: string): boolean {
  return CREDIT_CARD_NOTICE.test(title + "\n" + body);
}

export function readMyVibNotification(title: string, body: string, receivedAt: string) {
  const text = (title + "\n" + body).normalize("NFC");
  const amounts = new Set<string>();
  let ambiguous = false;
  // Ignore the balance and its value even when they span multiple lines.
  for (const part of [title, body]) {
    for (const match of part.normalize("NFC").split(BALANCE, 1)[0].matchAll(AMOUNT)) {
      const parsed = readSignedBankAmount(match[1]);
      if (parsed.amount === null) ambiguous = true;
      else amounts.add((parsed.type === TransactionType.INCOME ? "+" : "-") + parsed.amount + " VND");
    }
  }

  const { type, amount } = readSignedBankAmount(!ambiguous && amounts.size === 1 ? [...amounts][0] : "");
  const dates = new Set([...text.matchAll(DATE)].map(match => transactionDate(match[0])).filter(Boolean));
  const date = (dates.size === 1 ? [...dates][0] : null) ?? vietnamBankDate(receivedAt);
  const description = type === TransactionType.INCOME ? "Nhận tiền qua MyVIB"
    : type === TransactionType.EXPENSE ? "Chuyển tiền qua MyVIB" : "Giao dịch MyVIB";
  return { type, amount, date, description, category: "" };
}
