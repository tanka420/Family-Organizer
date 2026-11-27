/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// Ví dụ đi chợ: "50000+20000" → 70.000; "5*10000" → 50.000; "50000+5*3000" → 65.000.
// Bỏ dấu phân tách hàng nghìn (. ,) và khoảng trắng; chỉ tính + - * (không eval).
function evalMoneyExpression(input: string): number {
  if (!input || !input.trim()) return 0;
  // Bỏ khoảng trắng + dấu phân tách hàng nghìn, cắt các toán tử thừa ở cuối (đang gõ dở)
  const cleaned = input.replace(/[\s.,]/g, "").replace(/[+\-*]+$/, "");
  if (!cleaned) return 0;
  // Không phải biểu thức hợp lệ → lấy phần chữ số cho an toàn
  if (!/^[+\-]?\d+([+\-*]\d+)*$/.test(cleaned)) {
    return Number(cleaned.replace(/[^\d]/g, "")) || 0;
  }
  // Tách theo + / - (giữ dấu), mỗi số hạng có thể chứa phép nhân
  const terms = cleaned.match(/[+\-]?[^+\-]+/g) || [];
  let total = 0;
  for (const term of terms) {
    const sign = term.startsWith("-") ? -1 : 1;
    const factors = term.replace(/^[+\-]/, "").split("*").map(Number);
    total += sign * factors.reduce((a, b) => a * b, 1);
  }
  return Math.round(total);
}

// Nhóm hàng nghìn cho CẢ biểu thức đang gõ: "50000+20000" → "50.000+20.000".
// Giữ lại toán tử + - *, bỏ mọi ký tự khác (kể cả dấu chấm cũ) rồi nhóm lại từng số.
function formatMoneyExpr(input: string): string {
  const cleaned = input.replace(/[^\d+\-*]/g, "");
  return cleaned.replace(/\d+/g, (m) => Number(m).toLocaleString("vi-VN"));
}

interface MoneyInputProps {
  value: number;
  onChange: (n: number) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  autoFocus?: boolean;
  /** Hiện nút +/× hỗ trợ cộng dồn (bàn phím số trên mobile không có toán tử). */
  operators?: boolean;
}

/**
 * Ô nhập tiền: LUÔN hiển thị số có nhóm hàng nghìn (2.000.000), kể cả khi đang
 * gõ biểu thức cộng dồn (50.000+20.000). Có nút +/× (tuỳ chọn) và dòng preview
 * kết quả "= 70.000 đ". Quy tắc chung cho mọi ô tiền trong app.
 */
export function MoneyInput({ value, onChange, placeholder, className, id, autoFocus, operators }: MoneyInputProps) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const hasOperator = /\d\s*[+\-*]\s*\d/.test(raw);
  const preview = evalMoneyExpression(raw);
  // Khi rời ô: hiển thị theo value đã chốt; khi đang gõ: hiển thị raw (đã nhóm nghìn)
  const display = focused ? raw : (value > 0 ? value.toLocaleString("vi-VN") : "");

  const commit = () => {
    onChange(evalMoneyExpression(raw));
    setFocused(false);
  };

  const setFromInput = (text: string) => {
    const formatted = formatMoneyExpr(text);
    setRaw(formatted);
    onChange(evalMoneyExpression(formatted));
  };

  const appendOp = (op: string) => {
    const base = raw.trim() === "" && value > 0 ? value.toLocaleString("vi-VN") : raw;
    const trimmed = base.replace(/[+\-*]+$/, "");
    if (trimmed === "") return;
    const next = trimmed + op;
    setRaw(next);
    setFocused(true);
    onChange(evalMoneyExpression(next));
    inputRef.current?.focus();
  };

  return (
    <div className="relative">
      <div className="flex items-stretch gap-1.5">
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="numeric"
          autoFocus={autoFocus}
          value={display}
          placeholder={placeholder}
          onFocus={() => { setRaw(value > 0 ? value.toLocaleString("vi-VN") : ""); setFocused(true); }}
          onChange={(e) => setFromInput(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); inputRef.current?.blur(); } }}
          className={className}
        />
        {operators && (
          <div className="flex gap-1 shrink-0">
            <button
              type="button" tabIndex={-1} aria-label={t("finance.moneyAddPlus")}
              onPointerDown={(e) => e.preventDefault()} onClick={() => appendOp("+")}
              className="w-9 grid place-items-center rounded-lg bg-slate-800 hover:bg-emerald-500/20 text-slate-300 hover:text-emerald-400 font-bold text-lg leading-none transition-colors"
            >+</button>
            <button
              type="button" tabIndex={-1} aria-label={t("finance.moneyMulTimes")}
              onPointerDown={(e) => e.preventDefault()} onClick={() => appendOp("*")}
              className="w-9 grid place-items-center rounded-lg bg-slate-800 hover:bg-sky-500/20 text-slate-300 hover:text-sky-400 font-bold text-sm leading-none transition-colors"
            >×</button>
          </div>
        )}
      </div>
      {focused && hasOperator && (
        <p className="mt-1 text-[11px] font-mono font-bold text-emerald-400">= {preview.toLocaleString("vi-VN")} đ</p>
      )}
    </div>
  );
}

