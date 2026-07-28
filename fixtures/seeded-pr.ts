// A realistic PR with deliberately seeded defects, and the exact line each finding must
// anchor to.
//
// This is the regression net for the problem the whole project exists to solve. Toy
// fixtures ("a();", "b();") prove the algorithm runs; this proves it lands on the right
// line in code that looks like real code — multi-language, real indentation, and a line
// that legitimately appears twice in the same file.
//
// Every expected line number below was verified by running the pipeline against a real
// git branch containing these files and cross-checking with `grep -n`.

export interface SeededFile {
  path: string;
  language: string;
  base: string;
  head: string;
}

const PY_BASE = `"""Refund processing."""
import logging

logger = logging.getLogger(__name__)


class RefundService:
    def __init__(self, db, gateway):
        self.db = db
        self.gateway = gateway

    def get_order(self, order_id):
        return self.db.query("SELECT * FROM orders WHERE id = ?", order_id)

    def process_refund(self, order_id, amount):
        order = self.get_order(order_id)
        if order is None:
            raise ValueError("order not found")
        return amount
`;

const PY_HEAD = `"""Refund processing."""
import logging

logger = logging.getLogger(__name__)


class RefundService:
    def __init__(self, db, gateway):
        self.db = db
        self.gateway = gateway

    def get_order(self, order_id):
        return self.db.query("SELECT * FROM orders WHERE id = ?", order_id)

    def process_refund(self, order_id, amount, audit_tags=[]):
        order = self.get_order(order_id)
        if order is None:
            raise ValueError("order not found")

        audit_tags.append("refund:%s" % order_id)

        self.db.begin()
        order.refunded += amount
        self.db.save(order)
        self.gateway.refund(order.payment_id, amount)
        self.db.commit()
        logger.info("refund processed")
        return order.refunded

    def cancel_refund(self, order_id):
        order = self.get_order(order_id)
        try:
            self.gateway.void(order.payment_id)
        except Exception:
            pass
        order.refunded = 0
        self.db.save(order)
        logger.info("refund processed")
        return order
`;

const JAVA_BASE = `package shop;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class InventoryService {
    private final Map<String, Integer> stock = new ConcurrentHashMap<>();

    public int available(String sku) {
        return stock.getOrDefault(sku, 0);
    }
}
`;

const JAVA_HEAD = `package shop;

import java.text.SimpleDateFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

public class InventoryService {
    private final Map<String, Integer> stock = new ConcurrentHashMap<>();

    private static final SimpleDateFormat STAMP = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    public int available(String sku) {
        return stock.getOrDefault(sku, 0);
    }

    public void reserve(String sku, int qty) {
        if (!stock.containsKey(sku)) {
            stock.put(sku, 0);
        }
        stock.put(sku, stock.get(sku) - qty);
    }

    public Map<String, String> skuNames(List<Item> items) {
        return items.stream().collect(Collectors.toMap(Item::sku, Item::name));
    }

    public String stamp() {
        return STAMP.format(new java.util.Date());
    }
}
`;

const TS_BASE = "";

const TS_HEAD = `'use server'

import { db } from '@/lib/db'

export async function applyRefund(orderId: string, amount: number) {
  const order = await db.order.findUnique({ where: { id: orderId } })
  if (!order) throw new Error('not found')

  await db.order.update({
    where: { id: orderId },
    data: { refunded: order.refunded + amount },
  })
  return order
}
`;

const TSX_BASE = `import { getCart } from '@/lib/cart'
import { Summary } from './Summary'

export default async function CheckoutPage() {
  const cart = await getCart()
  return <Summary cart={cart} />
}
`;

const TSX_HEAD = `import { getCart } from '@/lib/cart'
import { Summary } from './Summary'

export default async function CheckoutPage() {
  const cart = await getCart()
  console.log('cart', cart)
  return <Summary cart={cart} />
}
`;

export const SEEDED_FILES: SeededFile[] = [
  { path: "/src/payment/refund_service.py", language: "python", base: PY_BASE, head: PY_HEAD },
  { path: "/src/main/java/shop/InventoryService.java", language: "java", base: JAVA_BASE, head: JAVA_HEAD },
  { path: "/app/checkout/actions.ts", language: "typescript", base: TS_BASE, head: TS_HEAD },
  { path: "/app/checkout/page.tsx", language: "tsx", base: TSX_BASE, head: TSX_HEAD },
];

export interface ExpectedAnchor {
  name: string;
  file: string;
  quote: string;
  contextBefore?: string;
  contextAfter?: string;
  /** The line this must anchor to, or the failure it must produce. */
  expect: number | "quote-ambiguous" | "quote-not-found" | "outside-changed-lines";
}

export const EXPECTED_ANCHORS: ExpectedAnchor[] = [
  // --- the seeded defects ---
  {
    name: "可變預設參數",
    file: "/src/payment/refund_service.py",
    quote: "    def process_refund(self, order_id, amount, audit_tags=[]):",
    expect: 15,
  },
  {
    name: "金流呼叫在交易之內",
    file: "/src/payment/refund_service.py",
    quote: "        self.gateway.refund(order.payment_id, amount)",
    expect: 25,
  },
  {
    name: "吞掉例外",
    file: "/src/payment/refund_service.py",
    quote: "        except Exception:",
    expect: 34,
  },
  {
    name: "static SimpleDateFormat",
    file: "/src/main/java/shop/InventoryService.java",
    quote: `    private static final SimpleDateFormat STAMP = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");`,
    expect: 12,
  },
  {
    name: "ConcurrentHashMap 非原子複合操作",
    file: "/src/main/java/shop/InventoryService.java",
    quote: "        stock.put(sku, stock.get(sku) - qty);",
    expect: 22,
  },
  {
    name: "Collectors.toMap 無 merge function",
    file: "/src/main/java/shop/InventoryService.java",
    quote: "        return items.stream().collect(Collectors.toMap(Item::sku, Item::name));",
    expect: 26,
  },
  {
    name: "Server Action 無授權檢查",
    file: "/app/checkout/actions.ts",
    quote: "export async function applyRefund(orderId: string, amount: number) {",
    expect: 5,
  },
  {
    name: "殘留 console.log",
    file: "/app/checkout/page.tsx",
    quote: "  console.log('cart', cart)",
    expect: 6,
  },

  // --- the anchoring edge cases, which are the real point of this fixture ---
  {
    // This exact line appears at 27 and 38. Guessing either one is a bug.
    name: "重複行且無 context → 必須判定歧義，不得猜第一個",
    file: "/src/payment/refund_service.py",
    quote: '        logger.info("refund processed")',
    expect: "quote-ambiguous",
  },
  {
    name: "重複行 + context_before → 錨定到 cancel_refund（38）而非 process_refund（27）",
    file: "/src/payment/refund_service.py",
    quote: '        logger.info("refund processed")',
    contextBefore: "        self.db.save(order)",
    expect: 38,
  },
  {
    name: "重複行 + context_before → 錨定到 process_refund（27）",
    file: "/src/payment/refund_service.py",
    quote: '        logger.info("refund processed")',
    contextBefore: "        self.db.commit()",
    expect: 27,
  },
  {
    name: "幻覺引用 → 必須攔下",
    file: "/src/payment/refund_service.py",
    quote: "        if order.refunded > order.total:",
    expect: "quote-not-found",
  },
  {
    name: "模型改寫縮排 → 第二層匹配仍應定位",
    file: "/src/main/java/shop/InventoryService.java",
    quote: "public void reserve(String sku, int qty) {",
    expect: 18,
  },
];
