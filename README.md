# khendzodsit AI

An installable, mobile-first Chrome PWA that applies the attached CRT X-Ray rules to imported or live OHLC candles. The app uses deterministic browser-side analysis and does not place trades.

## Use

1. Serve this folder from a local web server or publish it with GitHub Pages.
2. On launch, the app automatically connects to Deriv and resolves XAUUSD, NAS100, US30, GER30, Oil, and DXY against Deriv's active-symbol list. XAUUSD is selected by default.
3. Choose an available market in Trade. Set M1, M5, M15, M30, H1, H4, or D1 in Settings. Changing the symbol or timeframe restarts the live feed. Markets not returned by Deriv are shown as unavailable.
4. Android Chrome can install the hosted HTTPS app from the page install button or Chrome menu.

The floating **Ask AI** assistant accepts typed questions and, in browsers with Web Speech support (including Android Chrome), voice commands. It can read the six market signals and levels, report the U.S. labor read, navigate app sections, select a market, and refresh labor/news. Replies can be spoken aloud; choose an installed device voice and adjust the speech rate in the assistant panel. It prefers a voice whose name suggests a feminine voice when available, but voice choices depend on the browser and Android text-to-speech installation. It is an app assistant with supported commands, not an unrestricted general-purpose AI; general questions need a secure AI backend. It does not execute trades.

You can also import CSV candles (`time, open, high, low, close`) or load the synthetic demo data. Macro News includes an XAUUSD snapshot and refreshes public Google News, Federal Reserve, and BLS RSS headlines every five minutes. The snapshot uses the currently loaded XAUUSD candles, and the headline gold bias is a keyword heuristic. RSS availability depends on the browser network and the public CORS proxy; the News tab also accepts CSV headlines with `time, title, source, summary, url` columns.

The News tab also includes an economic calendar based on the attached Economic AI Dashboard. It provides Upcoming, Today, This Week and Next Week views, currency and impact filters, forecast-versus-previous reads, actual-result checks and heuristic market mappings. The browser version uses the public ShowMyTrades calendar endpoint because the MQL5 terminal calendar functions are not available to a static web app. The provider covers USD, GBP and JPY among the script's selected currencies; ZAR can be selected but is not present in that feed. The feed is refreshed every 15 minutes. Outcome agreement is calculated from actual releases in the current calendar window, not a historical trading win rate.

A separate U.S. Labor dashboard shows monthly nonfarm payroll changes, unemployment, average hourly earnings, month-over-month and year-over-year changes, report surprises when a matching forecast is available, an overall **STRONG**, **WEAK**, or mixed labor read, and the last 12 actual observations. It compares actuals with a matching consensus forecast when present and otherwise uses the trailing 12-month trend. It retrieves the same PAYEMS, UNRATE and CES0500000003 monthly series used by the attached updater from FRED's public CSV feed, caches observations on-device, and refreshes the feed every three minutes. The MQL5 updater's shared Common Files are not readable by a browser, so the app fetches the public data feed directly. Actual labor data updates when the agencies publish or revise monthly numbers, so a three-minute refresh does not mean the underlying statistics change every three minutes.

Each News dashboard panel can be minimized and restored independently.

## Chart and signals

The Signals tab requests live candle history and updates for all six requested Deriv markets: XAUUSD, NAS100, US30, GER30, Oil, and DXY. Each market gets its own CRT-based **BUY**, **SELL**, **WAIT**, or invalidated read and latest price. BUY/SELL cards include a Model #1 entry reference, invalidation stop, and 1R/2R targets. Select **Enable alerts** and grant browser notification permission to receive new live setup and invalidation alerts with levels. Browser-only notifications require the PWA to be open and connected; they are not server push. Markets unavailable on the public Deriv feed are clearly marked. A market displays WAIT when its candle data does not meet the configured setup conditions; the app does not force a direction.

The Chart tab uses a MetaTrader-inspired dark terminal layout with candlesticks, a right-side price scale, time axis, OHLC readout, and last-price marker. Drag or touch-drag to pan candles, pinch or use the mouse wheel to zoom, and use the zoom buttons or Reset control as needed. The Chart Shift button moves the latest candle left to leave open chart space on its right, like MT5; its setting is saved on the device. The overlay shows the qualifying CRT range and EQ, liquidity sweep, Model #1 level/break/retest, a TBS entry, Model #2 FVG zone, Model #3 BOS/retest and delivery/invalidation status when those conditions are found in the loaded candles. Confirmed directional setups are labeled **BUY** or **SELL**; unconfirmed and invalidated conditions remain **WAIT** or **SETUP INVALID**.

### Market dashboard

The Scan tab is now a live market dashboard inspired by the supplied phone mockup. It reuses the selected Deriv symbol and timeframe, plots loaded candles with EMA 21 plus recent liquidity and demand levels, and displays the existing rule-based strategy direction, trade score, confluence estimate, entry, stop, and target. Structure, BOS, and premium/discount labels are derived from recent bars. The News card shows upcoming public calendar events or recent macro headlines. The risk panel and position-size calculator use values entered on this device; they are not connected to a broker account, and contract value per point must be entered from the broker's instrument specification. BUY and SELL are paper previews. Auto monitor only displays analysis. No control on this dashboard sends an order. Backtest is a placeholder; it does not produce a historical performance report.

## Deriv live data

The PWA connects directly to Deriv's public WebSocket endpoint: `wss://api.derivws.com/trading/v1/options/ws/public`. It requests `active_symbols`, a candle history subscription using `ticks_history`, and a live `ticks` subscription. It resolves Deriv's current symbol names (`underlying_symbol` and `underlying_symbol_name`) before subscribing, and supports the older `symbol` and `display_name` response fields as a fallback. The public market-data connection requires no account login or token. It is read-only and does not submit trades.

DXY is included in the requested watchlist. Deriv documents DXYUSD for its MT5 Financial account; if DXY is absent from the public options endpoint's active symbols, the app will label it unavailable instead of presenting a stale quote.

The browser must have internet access, and the site must be served over HTTPS when deployed. If Deriv returns an error for a symbol, choose a symbol from the active-market list loaded by the app.

## Automatic trade strategy engine

The Trade screen continuously analyzes the selected market as Deriv candles arrive (or when imported candles are loaded). It ranks three rule-based setups—EMA trend pullback, CRT sweep with Model #1, and a recent-range breakout—and displays the highest-scoring setup, BUY/SELL/WAIT, a 0–100 trade score, entry reference, stop, and 1R/2R target levels. It needs at least 30 candles; otherwise it waits for more data. The displayed confidence is a heuristic confluence measure based on indicator agreement, not a statistically calibrated win probability. The “top strategy” means the highest current score among these three rules, not a guarantee of the best or profitable strategy. This engine analyzes only; it never opens or manages a trade. Review live spread, symbol specifications, and risk before acting.

## Signal logic

The attached MQL5 indicator defines CRT range qualification, sweep direction, and Model #1. This PWA adapts those concepts into a deterministic read. Since loaded candle data may not identify the original higher timeframe, the app groups candles into approximate blocks based on the loaded history. Validate signals against your chart; they are not guaranteed outcomes or financial advice. Demo candles are synthetic.

## GitHub Pages

Create a repository named `khendzodsit-ai`, add the contents of this folder at the repository root, then enable Pages from the `main` branch and `/ (root)`. Serve over HTTPS so Android Chrome can install the PWA.
