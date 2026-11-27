import { describe, expect, it } from "vitest";
import { isMyVibCreditCardNotice, readMyVibNotification } from "./myvibImport.js";

const receivedAt = "2026-11-27T19:00:00Z";

describe("MyVIB account notifications", () => {
  it.each([
    ["TK ****1234: +4,000 đ 10:12 27/11/2026", "income", 4000, "Nhận tiền qua MyVIB"],
    ["TK **1234 -2,200 đ\n28/11/2026 01:05", "expense", 2200, "Chuyển tiền qua MyVIB"],
    ["Tài khoản ••••1234: −2.200 VND lúc 11:21 27/11/2026", "expense", 2200, "Chuyển tiền qua MyVIB"],
  ])("reads a signed transaction from %s", (body, type, amount, description) => {
    expect(readMyVibNotification("MyVIB", body, receivedAt)).toMatchObject({ amount, type, description, category: "" });
  });

  it("uses the date in the notification before the delivery date", () => {
    expect(readMyVibNotification("MyVIB", "+4,000 đ 27/11/2026", receivedAt).date).toBe("2026-11-27");
    expect(readMyVibNotification("MyVIB", "+4,000 đ 31/11/2026", receivedAt).date).toBe("2026-11-28");
    expect(readMyVibNotification("MyVIB", "+4,000 đ 2026-11-26", receivedAt).date).toBe("2026-11-26");
  });

  it("accepts the same signed amount in both title and body and skips a closing balance", () => {
    expect(readMyVibNotification("+4,000 đ", "TK: +4,000 đ. Số dư:\n+99,000 đ", receivedAt))
      .toMatchObject({ type: "income", amount: 4000 });
  });

  it.each([
    "Số dư:\n+99,000 đ",
    "TK 1234 Biến động 2,200 đ",
    "TK 1234 +4,000 đ và -2,200 đ",
    "TK 1234 +4,00 đ",
    "TK 1234 +1,234.567 đ",
    "TK 1234 +0 đ",
    "TK 1234 +20 USD",
  ])("leaves the amount undecided for %s", body => {
    expect(readMyVibNotification("MyVIB", body, receivedAt)).toMatchObject({ type: "", amount: null, category: "" });
  });

  it("identifies explicitly labelled credit card notifications", () => {
    expect(isMyVibCreditCardNotice("Thông báo thẻ tín dụng", "−2.200 VND")).toBe(true);
    expect(isMyVibCreditCardNotice("MyVIB", "The tin dung")).toBe(true);
    expect(isMyVibCreditCardNotice("Credit card", "−2.200 VND")).toBe(true);
    expect(isMyVibCreditCardNotice("MyVIB", "TK ****1234: -2,200 đ")).toBe(false);
  });
});
