/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const INCOME_CATEGORIES = [
  "Lương tháng",
  "Tiền thưởng",
  "Làm thêm / Freelance",
  "Hoa hồng bán hàng",
  "Cổ tức",
  "Lợi nhuận cổ phần / Đầu tư",
  "Cho thuê (nhà/xe...)",
  "Tiền mượn / Vay",
  "Được cho / Biếu tặng",
] as const;
export const INCOME_CUSTOM = "__custom__";
export const isPresetIncome = (cat: string) => (INCOME_CATEGORIES as readonly string[]).includes(cat);
