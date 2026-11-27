/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type ErrorRequestHandler } from "express";
import { isBidvImportToken, parseBidvEvent } from "./bidvImport.js";
import { FamilyDB } from "./db.js";

const bidvJsonError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.too.large") {
    res.status(413).json({ error: "Dữ liệu thông báo vượt giới hạn." });
  } else if (error.status === 415) {
    res.status(415).json({ error: "Định dạng gửi thông báo không được hỗ trợ." });
  } else {
    res.status(400).json({ error: "Dữ liệu JSON không hợp lệ." });
  }
};

export function createBidvImportRouter(isMaintenance: () => boolean, onAccepted: (transactionId?: string) => void) {
  const router = express.Router();
  router.post(
    "/",
    (req, res, next) => {
      res.set("Cache-Control", "no-store");
      const secret = process.env.BIDV_IMPORT_TOKEN?.trim();
      if (!secret) {
        res.status(503).json({ error: "Nhận thông báo BIDV đang tắt." });
        return;
      }
      if (!isBidvImportToken(req.get("Authorization"), secret)) {
        res.status(401).json({ error: "Token nhận thông báo BIDV không hợp lệ." });
        return;
      }
      if (!req.is("application/json")) {
        res.status(415).json({ error: "Dữ liệu phải có định dạng application/json." });
        return;
      }
      next();
    },
    express.json({ limit: "32kb", inflate: false }),
    (req, res) => {
      // Backup restore can start while the HTTP body is still streaming.
      if (isMaintenance()) {
        res.status(503).json({ error: "Máy chủ đang khôi phục dữ liệu. Hãy thử lại." });
        return;
      }
      const parsed = parseBidvEvent(req.body);
      if ("error" in parsed) {
        res.status(400).json(parsed);
        return;
      }

      try {
        const { status, transactionId } = FamilyDB.receiveBidvImport(parsed.event);
        if (status === "conflict") {
          res.status(409).json({ error: "Mã thông báo đã được dùng cho nội dung khác." });
          return;
        }
        if (status === "accepted") onAccepted(transactionId);
        res.status(status === "accepted" ? 201 : 200).json({ status });
      } catch {
        console.error("Không lưu được thông báo BIDV vào SQLite.");
        res.status(500).json({ error: "Chưa lưu được thông báo BIDV. Hãy thử lại." });
      }
    }
  );
  router.all("/", (_req, res) => {
    res.set("Allow", "POST").status(405).json({ error: "API này chỉ nhận yêu cầu POST." });
  });
  router.use(bidvJsonError);
  return router;
}
