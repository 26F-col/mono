import { XStocksOracle } from "../sdk/src/xstocks";
import { TEST_ASSETS } from "../sdk/src/config";

async function main() {
    const oracle = new XStocksOracle();
    const symbols = TEST_ASSETS.map((a) => a.symbol);
    const feeds = await oracle.getFeeds(symbols);
    for (const [symbol, feed] of Object.entries(feeds)) console.log(symbol, feed);

    const allPriced = Object.values(feeds).every((f) => f.priceCents > 0);
    if (!allPriced) {
        console.error("SMOKE FAIL");
        process.exit(1);
    }
    console.log("SMOKE OK");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
