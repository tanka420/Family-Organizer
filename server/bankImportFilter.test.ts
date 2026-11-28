import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionType, type BankImportSource, type FamilyOrganizerDB } from "../src/types.js";
import express from "express";
import { createServer } from "node:http";

const storage = vi.hoisted(() => ({ data: {} as FamilyOrganizerDB }));
vi.mock("./sqlite.js", () => ({
  sqliteIsEmpty: () => false,
  sqliteLoad: () => structuredClone(storage.data),
  sqliteSave: (data: FamilyOrganizerDB) => { storage.data = structuredClone(data); },
  sqliteWriteTransaction: (apply: () => unknown) => apply(),
  sqliteCheckpoint: () => {},
}));
vi.mock("./push.js", () => ({ dispatchPush: vi.fn() }));
import { FamilyDB } from "./db.js";
import { createBankImportRouter } from "./bidvImportRoute.js";

const receivedAt = "2026-11-28T12:07:00Z";
const promotion = {
  eventId: "promotion", receivedAt,
  title: "Săn deal nhanh, vi vu an lành ✈️",
  body: "✨ Giảm ngay 30% phí Bảo hiểm du lịch BIC khi mua trên BIDV SmartBanking! 💖 Thêm an tâm cho mỗi hành trình, khám phá ưu đãi từ nay tới 30/11/2026!",
};

beforeEach(() => {
  storage.data = { users: [{ id: "admin", role: "admin" }] } as FamilyOrganizerDB;
});

describe("bank notification filtering", () => {
  it.each<BankImportSource>(["bidv", "myvib"])("ignores the pictured promotion for %s without creating a transaction or alert", source => {
    expect(FamilyDB.receiveBankImport(source, promotion)).toEqual({ status: "ignored" });
    expect(FamilyDB.getPendingBankImports(source)).toEqual([]);
    expect(storage.data.transactions).toEqual([]);
    expect(storage.data.notifications).toEqual([]);
  });

  it.each([
    ["bidv", "Bảo trì hệ thống", "SmartBanking bảo trì từ 23:00 tới 02:00 ngày 30/11/2026"],
    ["bidv", "Mã OTP", "OTP giao dịch 123456. Không chia sẻ mã xác thực."],
    ["bidv", "Mã xác thực", "Số tiền GD: -3,000 VND. Nhập OTP để xác nhận."],
    ["bidv", "SmartBanking", "Giao dịch không thành công. Số tiền GD: -3,000 VND"],
    ["myvib", "Ưu đãi", "Nhận ngay +100,000 đ khi mở tài khoản, giảm 30% hôm nay!"],
    ["myvib", "MyVIB", "Số dư: +99,000 đ"],
    ["myvib", "Giao dịch thất bại", "TK ****1234: -2,200 đ"],
    ["myvib", "Thông báo thẻ tín dụng", "TK ****1234: -2,200 đ"],
  ] as const)("ignores non-account-transaction notices (%s, %s)", (source, title, body) => {
    expect(FamilyDB.receiveBankImport(source, { ...promotion, title, body })).toEqual({ status: "ignored" });
    expect(FamilyDB.getPendingBankImports(source)).toEqual([]);
    expect(storage.data.notifications).toEqual([]);
  });

  it.each([
    ["bidv", "SmartBanking", "Số tiền GD: -3,000 VND Số dư cuối: 215,053 VND Nội dung: Thanh toán bảo hiểm ưu đãi"],
    ["bidv", "SmartBanking", "Số tiền GD: +2,000 VND Nội dung: chuyen tien qua MoMo"],
    ["bidv", "SmartBanking", "Số tiền GD: -3,000 VND Nội dung: Mã OTP và bảo trì hệ thống"],
    ["bidv", "SmartBanking", "Số tiền GD: 2,000 VND Nội dung: Chưa rõ dấu tiền"],
    ["myvib", "MyVIB", "TK ****1234: +4,000 đ 10:12 27/11/2026"],
    ["myvib", "MyVIB", "Tài khoản ••••1234: −2.200 VND lúc 11:21 27/11/2026"],
    ["myvib", "MyVIB", "TK 1234 Biến động 2,200 đ"],
    ["myvib", "+4,000 đ", "27/11/2026"],
  ] as const)("keeps real or incompletely parsed account transactions (%s, %s)", (source, title, body) => {
    expect(FamilyDB.receiveBankImport(source, { ...promotion, title, body })).toEqual({ status: "accepted" });
    expect(FamilyDB.getPendingBankImports(source)).toHaveLength(1);
    expect(storage.data.notifications).toHaveLength(1);
  });

  it("retains the ignored original notice and detects retries and event-id conflicts", () => {
    FamilyDB.receiveBankImport("bidv", promotion);
    expect(storage.data.bidvImports[0]).toMatchObject({
      title: promotion.title, body: promotion.body, status: "dismissed", reviewedBy: "system:bank-import-filter",
    });
    expect(FamilyDB.receiveBankImport("bidv", promotion).status).toBe("duplicate");
    expect(FamilyDB.receiveBankImport("bidv", { ...promotion, body: "Số tiền GD: +2,000 VND" }).status).toBe("conflict");
    expect(storage.data.bidvImports).toHaveLength(1);
  });

  it("cleans old irrelevant pending notices and their alerts while preserving transactions and reviewed history", () => {
    // Seed a snapshot written by the old version, before this filter existed.
    FamilyDB.receiveBankImport("bidv", { ...promotion, eventId: "real", body: "Số tiền GD: -3,000 VND" });
    FamilyDB.receiveBankImport("myvib", { ...promotion, eventId: "real", body: "TK ****1234: +2,000 đ" });
    const base = { ...promotion, createdAt: receivedAt };
    storage.data.bidvImports.push(
      { ...base, id: "old-promo", status: "pending" },
      { ...base, id: "reviewed", status: "approved", reviewedAt: receivedAt, reviewedBy: "admin", transactionId: "saved" },
      { ...base, id: "transfer", status: "internal-transfer", reviewedAt: receivedAt, reviewedBy: "admin",
        transfer: { type: TransactionType.EXPENSE, amount: 3000, date: "2026-11-28", description: "Chuyển nội bộ" } },
    );
    storage.data.myvibImports.push({ ...base, id: "myvib:old-promo", status: "pending" });
    storage.data.notifications.push(...["old-promo", "myvib:old-promo"].map((id, index) => ({
      id: `old-alert-${index}`, userId: "admin", type: "finance" as const, title: "Chờ duyệt", content: "",
      bidvImportId: id, createdAt: receivedAt, isRead: false,
    })));
    const reviewed = structuredClone(storage.data.bidvImports.slice(-2));
    const transactions = structuredClone(storage.data.transactions);

    FamilyDB.dismissNonTransactionBankImports();
    expect(FamilyDB.getPendingBankImports("bidv").map(event => event.id)).toEqual(["real"]);
    expect(FamilyDB.getPendingBankImports("myvib").map(event => event.id)).toEqual(["myvib:real"]);
    expect(storage.data.bidvImports.find(event => event.id === "old-promo")).toMatchObject({
      body: promotion.body, status: "dismissed", reviewedBy: "system:bank-import-filter",
    });
    expect(storage.data.bidvImports.slice(-2)).toEqual(reviewed);
    expect(storage.data.transactions).toEqual(transactions);
    expect(storage.data.notifications.map(item => item.bidvImportId).sort()).toEqual(["myvib:real", "real"]);
    const cleaned = structuredClone(storage.data);
    FamilyDB.dismissNonTransactionBankImports();
    expect(storage.data).toEqual(cleaned);
  });

  it.each<BankImportSource>(["bidv", "myvib"])("returns ignored over the %s hook without sending a sync alert", async source => {
    const key = source === "bidv" ? "BIDV_IMPORT_TOKEN" : "MYVIB_IMPORT_TOKEN";
    const previous = process.env[key];
    process.env[key] = "test-import-token";
    const onAccepted = vi.fn();
    const app = express();
    app.use("/", createBankImportRouter(source, () => false, onAccepted));
    const server = createServer(app);
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        method: "POST", headers: { Authorization: "Bearer test-import-token", "Content-Type": "application/json" },
        body: JSON.stringify(promotion),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ignored" });
      expect(onAccepted).not.toHaveBeenCalled();
      expect(storage.data.notifications).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
