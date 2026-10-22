// 用 @dreamcavy/ai-relay-sdk 写的 L1 供给方：一个 POST /relay，两个同步动作。
// 运行：RELAY_SECRET=... PORT=8787 pnpm example
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { completed, createRelayHandler, failed, toNodeHandler, type RelayHandler } from "@dreamcavy/ai-relay-sdk";

type Product = { sku: string; name: string; category: string; price_cents: number; stock: number };
type OrderInput = { sku: string; quantity: number; total_cents: number; recipient: string; phone: string; address: string };

export const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

export function createFlowerShop(secrets: string | string[]): RelayHandler {
  // 演示用内存库存；真实产品换成自己的数据库。
  const products: Product[] = [
    { sku: "rose-11", name: "红玫瑰 11 枝", category: "玫瑰", price_cents: 19900, stock: 20 },
    { sku: "lily-6", name: "香水百合 6 枝", category: "百合", price_cents: 15800, stock: 10 },
    { sku: "sun-3", name: "向日葵 3 枝", category: "向日葵", price_cents: 8800, stock: 0 },
  ];
  let seq = 0;

  return createRelayHandler({
    secrets,
    manifest,
    handlers: {
      list_products: (input: { category?: string }) =>
        completed(
          { products: products.filter((p) => !input.category || p.category === input.category) },
          [{ type: "markdown", text: products.map((p) => `- ${p.name}：¥${p.price_cents / 100}（库存 ${p.stock}）`).join("\n") }],
        ),

      // 同一个 idempotency_key 再来时，SDK 直接返回第一次的结果，这里只会执行一次。
      place_order: (input: OrderInput) => {
        const product = products.find((p) => p.sku === input.sku);
        if (!product) return failed("invalid_input", `没有商品 ${input.sku}`);
        if (input.total_cents !== product.price_cents * input.quantity) {
          return failed("invalid_input", `总价应为 ${product.price_cents * input.quantity} 分`);
        }
        if (product.stock < input.quantity) return failed("not_available", `${product.name} 库存不足`);
        product.stock -= input.quantity;
        const orderNo = `F${String(++seq).padStart(6, "0")}`;
        return completed({ order_no: orderNo, total_cents: input.total_cents }, [
          { type: "markdown", text: `已下单 **${product.name} × ${input.quantity}**，送给 ${input.recipient}，订单号 ${orderNo}。` },
        ]);
      },
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.RELAY_SECRET;
  if (!secret) throw new Error("请设置 RELAY_SECRET（Relay 后台给的 secret）");
  const secrets = [secret, process.env.RELAY_OLD_SECRET].filter((s): s is string => Boolean(s));
  const relay = toNodeHandler(createFlowerShop(secrets));
  const port = Number(process.env.PORT ?? 8787);
  createServer((req, res) => (req.url === "/relay" ? relay(req, res) : res.writeHead(404).end())).listen(port, () => {
    console.log(`示例花店：http://127.0.0.1:${port}/relay`);
  });
}
