import { describe, expect, it } from "vitest";
import { TransactionType } from "../src/types.js";
import { bidvCategoryRuleId, identifyBidvCounterparty, isBidvImportToken, parseBidvEvent, parseBidvReview, readBidvNotification, suggestBidvCategory } from "./bidvImport.js";

const example = {
  eventId: "demo-bidv-1",
  receivedAt: "2026-11-26T23:05:07.120+07:00",
  title: " Biến động số dư ",
  body: " +50.000 VND\nNội dung: Giao dịch mẫu ",
};

describe("BIDV import input", () => {
  it("normalizes the time and preserves the transaction text", () => {
    expect(parseBidvEvent(example)).toEqual({ event: {
      eventId: example.eventId,
      receivedAt: "2026-11-26T16:05:07.120Z",
      title: "Biến động số dư",
      body: "+50.000 VND\nNội dung: Giao dịch mẫu",
    } });
  });

  it("accepts a leap day and a notification with only a title", () => {
    expect(parseBidvEvent({ ...example, receivedAt: "2028-02-29T00:00:00Z", body: "" })).toHaveProperty("event");
  });

  it.each([
    "2026-11-26T23:05:07",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-11-26T24:00:00Z",
    "2026-11-26T23:05:07+14:01",
    "2026-11-26T23:05:07+01:60",
  ])("rejects an invalid receivedAt value (%s)", receivedAt => {
    expect(parseBidvEvent({ ...example, receivedAt })).toMatchObject({ fields: ["receivedAt"] });
  });

  it.each([
    [{ eventId: "demo/1" }, ["eventId"]],
    [{ eventId: "demo\n" }, ["eventId"]],
    [{ eventId: "" }, ["eventId"]],
    [{ eventId: "1".repeat(101) }, ["eventId"]],
    [{ eventId: 20261127095200000 }, ["eventId"]],
    [{ title: "x".repeat(161) }, ["title"]],
    [{ body: "x".repeat(3001) }, ["body"]],
    [{ title: " ", body: "\t" }, ["title", "body"]],
    [{ body: "bad\u0000value" }, ["body"]],
    [{ body: 123 }, ["body"]],
  ])("identifies the invalid fields %#", (changes, fields) => {
    expect(parseBidvEvent({ ...example, ...changes })).toMatchObject({ fields });
  });

  it("rejects missing fields, unexpected fields and non-object values", () => {
    const { body: _, ...withoutBody } = example;
    expect(parseBidvEvent(withoutBody)).toMatchObject({ fields: ["body"] });
    expect(parseBidvEvent({ ...example, amount: 50000 })).toHaveProperty("error");
    expect(parseBidvEvent([])).toHaveProperty("error");
    expect(parseBidvEvent(null)).toHaveProperty("error");
  });

  it("does not echo any submitted values in an error", () => {
    const submitted = "123 private iPhone value";
    const result = parseBidvEvent({ ...example, eventId: submitted });
    expect(JSON.stringify(result)).not.toContain(submitted);
  });

});

describe("BIDV import authentication", () => {
  const secret = "local-synthetic-token";

  it("accepts only the configured bearer credential", () => {
    expect(isBidvImportToken("Bearer " + secret, secret)).toBe(true);
    expect(isBidvImportToken("bearer " + secret, secret)).toBe(true);
    expect(isBidvImportToken("Bearer other-synthetic-token", secret)).toBe(false);
    expect(isBidvImportToken("Bearer " + secret + " extra", secret)).toBe(false);
    expect(isBidvImportToken("Basic " + secret, secret)).toBe(false);
    expect(isBidvImportToken(undefined, secret)).toBe(false);
    expect(isBidvImportToken("Bearer " + secret, "")).toBe(false);
  });
});

describe("BIDV review input", () => {
  const approval = {
    action: "approve",
    type: "expense",
    amount: 25000,
    date: "2026-11-26",
    description: " Thanh toán mẫu ",
    category: "food",
  };

  it("accepts a minimal dismissal", () => {
    expect(parseBidvReview({ action: "dismiss" })).toEqual({ action: "dismiss" });
  });

  it("normalizes the approved fields and defaults a blank category to other", () => {
    expect(parseBidvReview({ ...approval, category: " " })).toEqual({
      ...approval, description: "Thanh toán mẫu", category: "other",
    });
  });

  it("keeps a description only for an explicitly enabled auto-approval rule", () => {
    expect(parseBidvReview({ ...approval, autoApprove: true, reuseDescription: true }))
      .toMatchObject({ autoApprove: true, reuseDescription: true });
    expect(parseBidvReview({ ...approval, autoApprove: true, reuseDescription: false }))
      .not.toHaveProperty("reuseDescription");
    expect(parseBidvReview({ ...approval, reuseDescription: true })).toBeNull();
    expect(parseBidvReview({ ...approval, autoApprove: true, reuseDescription: "true" })).toBeNull();
    expect(parseBidvReview({ ...approval, action: "transfer", reuseDescription: true })).toBeNull();
  });

  it("accepts explicit opt-in and a separate transfer decision without a category", () => {
    expect(parseBidvReview({ ...approval, rememberCategory: true })).toMatchObject({ rememberCategory: true });
    const { category: _, ...fields } = approval;
    expect(parseBidvReview({ ...fields, action: "transfer" })).toEqual({
      ...fields, action: "transfer", description: "Thanh toán mẫu",
    });
    expect(parseBidvReview({ ...approval, category: "", rememberCategory: true })).toBeNull();
  });

  it.each([
    { action: "ignore" },
    { type: "" },
    { type: "transfer" },
    { amount: "25000" },
    { amount: 0 },
    { amount: -25000 },
    { amount: 1.5 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { date: "2026-02-29" },
    { date: "2026-11-26T00:00:00Z" },
    { description: " " },
    { description: "x".repeat(251) },
    { category: "x".repeat(101) },
  ])("rejects an invalid review %#", changes => {
    expect(parseBidvReview({ ...approval, ...changes })).toBeNull();
  });
});

describe("BIDV review suggestions", () => {
  const receivedAt = "2026-11-26T19:00:00Z";

  it("uses the signed transaction amount, explicit date and memo without a labeled reference", () => {
    const text = "TK: **** | Số tiền GD: -2,300 VND | Số dư: +25,000,000 VND | Ngày GD: 26/11/2026 23:00 | Nội dung: Thanh toán tiền điện | Mã GD: DEMO";
    expect(readBidvNotification(text, receivedAt)).toEqual({
      type: "expense", amount: 2300, date: "2026-11-26", description: "Thanh toán tiền điện", memo: "Thanh toán tiền điện",
    });
  });

  it.each([
    ["-", TransactionType.EXPENSE],
    ["+", TransactionType.INCOME],
  ])("separates a signed %s amount from the closing balance in a one-line BIDV notification", (sign, type) => {
    const text = `Tài khoản thanh toán: **** Số tiền GD: ${sign}3,000 VND Số dư cuối: 215,053 VND Nội dung giao dịch: Giao dịch mẫu`;
    expect(readBidvNotification(text, receivedAt)).toMatchObject({
      type, amount: 3000, description: "Giao dịch mẫu",
    });
  });

  it("supports formatted incoming VND and uses the date received in Vietnam when the date is invalid", () => {
    const text = "Số tiền GD: +1.234.000 VND\nNgày GD: 31/11/2026\nND: Lương tháng 11";
    expect(readBidvNotification(text, receivedAt)).toMatchObject({
      type: "income", amount: 1234000, date: "2026-11-27", description: "Lương tháng 11",
    });
  });

  it.each([
    "",
    "Số dư: +94,000 VND",
    "Tài khoản thanh toán: **** Số dư cuối: +94,000 VND Nội dung giao dịch: Giao dịch mẫu",
    "Số tiền GD: 2,000 VND",
    "Số tiền GD: +12.50 VND",
    "Số tiền GD: +12,345.000 VND",
    "Số tiền GD: +0 VND",
    "Số tiền GD: +2,000 USD",
    "Số tiền GD: +2,000 VND\nSố tiền GD: -3,000 VND",
  ])("leaves unclear amounts and directions for manual review (%s)", text => {
    expect(readBidvNotification(text, receivedAt)).toMatchObject({ type: "", amount: null });
  });

  it("suggests a single clear category and leaves generic or conflicting memos unclassified", () => {
    expect(suggestBidvCategory(TransactionType.EXPENSE, "Thanh toan tien dien thang 11")).toBe("utilities");
    expect(suggestBidvCategory(TransactionType.INCOME, "Lương THÁNG 11")).toBe("Lương tháng");
    expect(suggestBidvCategory(TransactionType.EXPENSE, "Tiền điện và đóng học phí")).toBe("");
    expect(suggestBidvCategory(TransactionType.INCOME, "chuyen tien qua VIB")).toBe("");
    expect(suggestBidvCategory(TransactionType.EXPENSE, "Lương tháng 11")).toBe("");
  });

  it("matches remembered rules by normalized memo and direction", () => {
    expect(bidvCategoryRuleId(TransactionType.EXPENSE, "  Thanh TOÁN  ")).toBe(
      bidvCategoryRuleId(TransactionType.EXPENSE, "Thanh toán"),
    );
    expect(bidvCategoryRuleId(TransactionType.EXPENSE, "Thanh toán")).not.toBe(
      bidvCategoryRuleId(TransactionType.INCOME, "Thanh toán"),
    );
    expect(bidvCategoryRuleId(TransactionType.EXPENSE, "")).toBeNull();
  });
});

describe("BIDV SmartBanking counterparty rules", () => {
  const expense = TransactionType.EXPENSE;
  const account = "0123456789";

  it("matches the two observed TKThe layouts and normalizes the bank name", () => {
    const incomingLayout = identifyBidvCounterparty(expense, `TKThe :${account}, tai VIB. Chuyen tien`);
    const outgoingLayout = identifyBidvCounterparty(expense, `MB-TKThe ${account}_NGUYỄN VĂN A, tại vib. Noi dung moi`);
    expect(incomingLayout).toEqual(outgoingLayout);
    expect(incomingLayout).toMatchObject({ bank: "VIB", accountEnding: "6789" });
  });

  it("distinguishes opposite directions, other banks and other full accounts with the same suffix", () => {
    const first = identifyBidvCounterparty(expense, `TKThe ${account}, tai VIB.`);
    expect(first?.id).toBeDefined();
    expect(identifyBidvCounterparty(TransactionType.INCOME, `TKThe ${account}, tai VIB.`)?.id).not.toBe(first?.id);
    expect(identifyBidvCounterparty(expense, `TKThe ${account}, tai MB.`)?.id).not.toBe(first?.id);
    expect(identifyBidvCounterparty(expense, "TKThe 1123456789, tai VIB.")?.id).not.toBe(first?.id);
  });

  it.each([
    "chuyen tien qua MoMo 0123456789",
    "Noi dung tu do TKThe 0123456789, tai VIB.",
    "Tài khoản thanh toán: 0123456789",
    "TKThe ****6789, tai VIB.",
    "TKThe 0123456789, tai VIB. TKThe 1123456789, tai MB.",
    "TKThe 0123456789, tai Viet Nam",
  ])("does not create a rule from ambiguous text (%s)", memo => {
    expect(identifyBidvCounterparty(expense, memo)).toBeNull();
  });

  it("requires an explicit boolean opt-in and a category", () => {
    const review = { action: "approve", type: expense, amount: 3000, date: "2026-11-27", description: "Mẫu", category: "food" };
    expect(parseBidvReview({ ...review, autoApprove: true })).toMatchObject({ autoApprove: true });
    expect(parseBidvReview({ ...review, autoApprove: false })).not.toHaveProperty("autoApprove");
    expect(parseBidvReview({ ...review, autoApprove: "true" })).toBeNull();
    expect(parseBidvReview({ ...review, autoApprove: true, category: "" })).toBeNull();
    expect(parseBidvReview({ ...review, autoApprove: true, action: "transfer" })).toBeNull();
  });
});

describe("BIDV ledger descriptions", () => {
  it.each([
    ["+", "TKThe :0123456789, tai VIB. @VA_DEMO_TEN NGUOI NHAN/1234567890_TIEN DIEN thang 11 -CTLNHIDI123456789012345-1/1-CRE-002", "TIEN DIEN thang 11"],
    ["+", "TKThe :0123456789, tai VIB. @VA_DEMO/1234567890_NGUYEN VAN A chuyen tien den NGUYEN VAN B 1234567890 - DONVI -CTLNHIDI123456789012345-", "Nhận tiền qua VIB"],
    ["-", "MB-TKThe 0123456789_NGUYEN VAN A, tai VIB. NGUYEN VAN A Chuyen tien -CTLNHIDO123456789012345", "Chuyển tiền đến VIB"],
    ["-", "MB-TKThe 0123456789_NGUYEN VAN A, tai ACB. Hóa đơn 123 - tháng 11", "Hóa đơn 123 - tháng 11"],
    ["+", "123456789012 1234567890 NGUYEN VAN A chuyen tien qua MoMo", "Nhận tiền qua MoMo"],
    ["-", "Chuyển tiền qua MoMo: Trả tiền sách 2", "Trả tiền sách 2"],
    ["+", "DEMO_NGUYEN VAN A/1234567890__123456789012 2345678901 Tien no", "Tien no"],
    ["-", "123456789012 1234567890 Chuỗi khác chưa rõ", "Chuyển tiền qua BIDV"],
    ["+", "Mua sach - lop 11 - MA GOC 1234", "Mua sach - lop 11 - MA GOC 1234"],
    ["-", "", "Chuyển tiền qua BIDV"],
    ["?", "", "Giao dịch BIDV"],
  ])("cleans description for %s and %s while retaining the full memo", (sign, memo, description) => {
    const body = `Số tiền GD: ${sign}3,000 VND Nội dung giao dịch: ${memo}`;
    const parsed = readBidvNotification(body, "2026-11-27T03:26:15.000Z");
    expect(parsed).toMatchObject({ memo, description });
  });
});
