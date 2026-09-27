const lenders = {
  aave: { name: "Aave", logo: "aave.png", available: 150000, rate: "7.5%", term: "30 days", note: "Fixed rate · No origination fee", badge: "AVAILABLE", eligible: true },
  morpho: { name: "Morpho", logo: "morpho.png", available: 100000, rate: "8.0%", term: "90 days", note: "Fixed rate · 0.25% origination", badge: "AVAILABLE", eligible: true },
  jupiter: { name: "Jupiter Lend", logo: "jupiter.png", available: 0, rate: "9.5%", term: "60 days", note: "Requires health factor above 2.0", badge: "INELIGIBLE", eligible: false }
};
const assets = {
  AAPLx: { name: "Apple", logo: "apple.png", balance: 1201, price: 339, advance: 60 },
  NVDx: { name: "Nvidia", logo: "nvidia.png", balance: 2500, price: 96, advance: 75 }
};
const state = {
  page: "browse",
  sidebarOpen: false,
  walletConnected: true,
  modalStep: 0,
  selectedLender: "aave",
  amount: "50000",
  selectedAsset: "AAPLx",
  depositAmount: "",
  assetMenuOpen: false,
  helpOpen: false
};
const main = document.getElementById("mainContent");
const sidebar = document.getElementById("sidebar");
const shell = document.getElementById("appShell");
const modalRoot = document.getElementById("modalRoot");
const walletButton = document.getElementById("walletToggle");
let toastTimer;

const svg = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>',
  right: '<svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3M2.5 13.5l5-5 4 2 7-7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  verified: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14.3 4l2.5-.1 1.3 2.1 2.2 1.2-.2 2.5L21 12l-.9 2.3.2 2.5-2.2 1.2-1.3 2.1-2.5-.1L12 21l-2.3-1-2.5.1-1.3-2.1-2.2-1.2.2-2.5L3 12l.9-2.3-.2-2.5 2.2-1.2 1.3-2.1 2.5.1L12 3Z"/><path d="m8.5 12 2.3 2.3 4.8-4.8"/></svg>'
};
function money(value) { return "$" + Math.round(Number(value) || 0).toLocaleString("en-US"); }
function lenderLogo(key, extraClass) { return '<img class="lender-logo ' + (extraClass || "") + '" src="./assets/' + lenders[key].logo + '" alt="' + lenders[key].name + ' logo" />'; }
function assetLogo(key) { return '<img class="asset-logo" src="./assets/' + assets[key].logo + '" alt="' + assets[key].name + ' logo" />'; }

function renderSidebar() {
  const links = [
    ["collateral", "Post Collateral", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z"/><path d="M12 8v8m-3-4h6"/></svg>'],
    ["browse", "Browse Lending", svg.chart],
    ["portfolio", "Portfolio", '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-5 0v3h2V7"/></svg>']
  ];
  sidebar.className = "sidebar" + (state.sidebarOpen ? " open" : "");
  shell.classList.toggle("sidebar-open", state.sidebarOpen);
  sidebar.innerHTML = '<button class="sidebar-close" data-action="menu" aria-label="Close navigation">' + svg.close + '</button><nav class="nav-list">' + links.map(([page, label, icon]) => '<button class="nav-link ' + (state.page === page ? "active" : "") + '" data-page="' + page + '" aria-current="' + (state.page === page ? "page" : "false") + '">' + icon + '<span class="nav-label">' + label + '</span></button>').join("") + '</nav>';
  walletButton.className = "wallet-button" + (state.walletConnected ? "" : " disconnected");
  walletButton.innerHTML = state.walletConnected ? '<span class="wallet-dot"></span><span>0x71F2...9A30</span>' + svg.chevron.replace("<svg", '<svg class="wallet-chevron"') : '<span>Connect Wallet</span>';
  walletButton.setAttribute("aria-label", state.walletConnected ? "Wallet 0x71F2 ending 9A30" : "Connect wallet");
}

function renderBrowse() {
  const rows = Object.keys(lenders).map((key) => {
    const lender = lenders[key];
    return '<article class="lender-card"><div class="lender-top">' + lenderLogo(key) + '<div class="lender-title-wrap"><div class="lender-title-row"><span class="lender-name">' + lender.name + '</span><span class="badge ' + (lender.eligible ? "available" : "ineligible") + '">' + lender.badge + '</span></div><div class="lender-subtitle">' + lender.note + '</div></div><button class="borrow-button" data-action="borrow" data-lender="' + key + '" ' + (!lender.eligible ? "disabled" : "") + '>Borrow</button></div><div class="lender-metrics"><div class="metric"><span class="metric-label">Available</span><strong class="metric-value">' + money(lender.available) + '</strong></div><div class="metric"><span class="metric-label">Rate</span><strong class="metric-value">' + lender.rate + '</strong></div><div class="metric"><span class="metric-label">Term</span><strong class="metric-value">' + lender.term + '</strong></div></div></article>';
  }).join("");
  return '<div class="content-width"><div class="page-heading"><h1>Browse Lending</h1><p>Compare available lenders and review their terms.</p></div><section class="capacity-card" aria-labelledby="capacityHeading"><div class="capacity-heading"><span class="capacity-icon">' + svg.chart + '</span><h2 id="capacityHeading">Your borrowing capacity</h2><span class="capacity-note">Based on your collateral</span></div><div class="capacity-stats"><div class="stat"><span class="stat-label">Eligible collateral</span><strong class="stat-value">$250,000</strong></div><div class="stat"><span class="stat-label">Borrowed</span><strong class="stat-value">$0</strong></div><div class="stat"><span class="stat-label">Available to borrow</span><strong class="stat-value green">$200,000</strong></div></div></section><div class="lender-section-heading"><div><h2>Available lending</h2><p>Choose a lender and review their terms.</p></div><button class="text-button" data-action="help">How rates work</button></div><section class="lender-list" aria-label="Available lenders">' + rows + '</section></div>';
}

function renderPortfolio() {
  return '<div class="content-width"><div class="page-heading portfolio-heading"><div class="eyebrow">Position overview</div><h1>Portfolio</h1><p>Your current position and risk status.</p></div><div class="portfolio-grid"><div class="portfolio-column"><section class="dashboard-card"><h2>Portfolio overview</h2><p class="card-subtitle">Live values across all active positions</p><div class="overview-stats"><div class="overview-stat"><span class="stat-label">Total collateral value</span><strong class="stat-value">$320,000</strong></div><div class="overview-stat"><span class="stat-label">Total borrowed</span><strong class="stat-value">$50,000</strong></div><div class="overview-stat"><span class="stat-label">Health factor</span><span class="health-pill">1.8</span></div></div></section><section class="dashboard-card"><div class="card-header-row"><h2>Position details</h2><button class="text-button" data-action="view-all">View all</button></div><div class="position-row">' + assetLogo("NVDx") + '<div><span class="position-symbol">NVDA</span><span class="position-company">Nvidia</span></div><div class="position-field"><span class="position-field-label">Collateral value</span><span class="position-field-value">$240,000</span></div><div class="position-field"><span class="position-field-label">Deposited</span><span class="position-field-value">2500 NVDA</span></div>' + svg.right + '</div></section><section class="dashboard-card"><div class="card-header-row"><h2>Current loans</h2><button class="text-button" data-action="view-all">View all</button></div><div class="loan-row">' + lenderLogo("aave") + '<div><div class="loan-name">Aave <span class="badge available">ACTIVE</span></div><div class="loan-desc">7.5% fixed · 30 d</div></div><div class="loan-field"><span class="position-field-label">Borrowed amount</span><strong class="position-symbol">$50,000</strong></div><div class="loan-field"><span class="position-field-label">Available credit</span><strong class="position-symbol">$150,000</strong></div>' + svg.right + '</div></section></div><div class="portfolio-column right-column"><section class="dashboard-card"><h2>Risk status</h2><div class="risk-status"><span class="risk-status-icon">' + svg.shield + '</span><div><strong>Healthy</strong><p>Your position is within safe parameters.</p></div>' + svg.right + '</div></section><section class="dashboard-card"><h2>Risk metrics</h2><p class="card-subtitle">Current account thresholds</p><div class="risk-metric-row"><span>Liquidation threshold</span><strong>1.10</strong></div><div class="risk-metric-row"><span>Current health factor</span><strong>1.80</strong></div><div class="risk-metric-row"><span>Buffer to threshold</span><strong>38.9%</strong></div></section><section class="dashboard-card"><h2>Collateral allocation</h2><div class="allocation-bar"><span></span></div><div class="allocation-legend"><span class="allocation-dot"></span>NVDA<strong>100%</strong></div></section></div></div></div>';
}

function renderCollateral() {
  const asset = assets[state.selectedAsset];
  const amount = Math.max(0, Number(state.depositAmount) || 0);
  const price = amount * asset.price;
  const collateral = price * asset.advance / 100;
  const menu = state.assetMenuOpen ? '<div class="asset-options" role="listbox">' + Object.keys(assets).map((key) => '<button class="asset-option ' + (key === state.selectedAsset ? "selected" : "") + '" data-action="select-asset" data-asset="' + key + '" role="option" aria-selected="' + (key === state.selectedAsset) + '">' + assetLogo(key) + '<span><strong class="asset-primary">' + key + '</strong><span class="asset-secondary">' + assets[key].name + '</span></span><span class="asset-holdings">' + assets[key].balance.toLocaleString("en-US") + '</span></button>').join("") + '</div>' : '';
  return '<div class="deposit-wrap"><section class="deposit-card"><h1>Post Collateral</h1><p class="deposit-intro">Select an asset and specify the amount you want to deposit.</p><label class="field-label">Asset</label><div class="asset-select-wrap"><button class="asset-select" data-action="asset-menu" aria-haspopup="listbox" aria-expanded="' + state.assetMenuOpen + '">' + assetLogo(state.selectedAsset) + '<span><span class="asset-primary">' + state.selectedAsset + '</span><span class="asset-secondary">' + asset.name + '</span></span><span class="asset-holdings">' + asset.balance.toLocaleString("en-US") + '<br>' + money(asset.balance * asset.price) + '</span>' + svg.chevron.replace("<svg", '<svg class="asset-select-chevron"') + '</button>' + menu + '</div><label class="field-label" for="depositAmount">Deposit Amount</label><div class="deposit-amount-row"><div class="amount-field"><input id="depositAmount" type="number" inputmode="decimal" min="0" max="' + asset.balance + '" step="any" placeholder="0" value="' + state.depositAmount + '" aria-label="Deposit amount"><span class="amount-unit">' + state.selectedAsset + '</span></div><button class="max-button" data-action="deposit-max">Max</button></div><div class="balance-line">Available balance&nbsp; ' + asset.balance.toLocaleString("en-US", { minimumFractionDigits: 2 }) + ' ' + state.selectedAsset + '</div><div class="estimate-box"><div class="estimate-row"><span>Price</span><strong>' + money(price) + '</strong></div><div class="estimate-row"><span>Advance rate</span><strong>' + Math.round(amount ? asset.advance : 0) + '%</strong></div><div class="estimate-row"><span>Estimated collateral value</span><strong>' + money(collateral) + '</strong></div></div><div class="vault-note">' + svg.shield + '<span>Your collateral is held in an audited smart-contract vault and remains verifiable onchain.</span></div><button class="primary-button" data-action="deposit" ' + (!state.walletConnected || !amount || amount > asset.balance || amount < 0 ? "disabled" : "") + '>Deposit</button></section></div>';
}

function renderModal() {
  if (!state.modalStep) { modalRoot.innerHTML = ""; return; }
  const key = state.selectedLender;
  const lender = lenders[key];
  const step = state.modalStep;
  const titles = { 1: "Choose lender", 2: "Request credit", 3: "Confirm request", 4: "Request status" };
  const stepLabels = ["Select lender", "Enter amount", "Review", "Status"];
  const steps = stepLabels.map((label, i) => {
    const number = i + 1;
    const completed = number < step;
    const current = number === step;
    const mark = completed ? svg.check : String(number);
    return '<div class="step-item ' + (completed ? "done" : "") + (current ? " current" : "") + '"><span class="step-circle">' + mark + '</span><span>' + label + '</span></div>' + (number < 4 ? '<span class="step-line ' + (number < step ? "done" : "") + '"></span>' : "");
  }).join("");
  let body = "";
  if (step === 1) {
    body = '<p class="modal-copy">Choose an available lender for your credit request.</p><div class="lender-choice-list">' + Object.keys(lenders).map((id) => '<button class="lender-choice ' + (id === key ? "selected" : "") + '" data-action="choose-lender" data-lender="' + id + '" ' + (!lenders[id].eligible ? "disabled" : "") + '>' + lenderLogo(id) + '<span class="lender-choice-main"><strong>' + lenders[id].name + '</strong><small>' + lenders[id].term + ' · ' + lenders[id].note + '</small></span><span class="lender-choice-rate">' + lenders[id].rate + '</span></button>').join("") + '</div><button class="primary-button modal-action" data-action="next-step">Continue</button>';
  } else if (step === 2) {
    body = '<div class="selected-lender">' + lenderLogo(key) + '<span><strong>' + lender.name + '</strong><small>' + lender.rate + ' fixed · ' + lender.term + '</small></span><button class="text-button" data-action="change-lender">Change</button></div><label class="modal-field-label" for="borrowAmount">Requested amount</label><div class="modal-amount-row"><div class="amount-field"><input id="borrowAmount" type="number" inputmode="numeric" min="1" max="200000" step="1000" value="' + state.amount + '" aria-label="Requested amount"><span class="amount-unit">USDC</span></div><button class="max-button" data-action="borrow-max">Max</button></div><div class="available-credit">Your available credit&nbsp; $200,000</div><div class="info-banner">' + svg.info + '<span>This request would use ' + Math.min(100, Math.round((Number(state.amount) || 0) / 2000)) + '% of your available credit and keep your health factor at 1.8.</span></div><button class="primary-button modal-action" data-action="next-step" ' + (!(Number(state.amount) > 0 && Number(state.amount) <= 200000) ? "disabled" : "") + '>Continue</button>';
  } else if (step === 3) {
    body = '<p class="modal-copy">Review the request details before submitting.</p><div class="review-box"><div class="review-row"><span>Lender</span><strong class="review-lender">' + lender.name + ' ' + lenderLogo(key, "review-logo") + '</strong></div><div class="review-row"><span>Amount</span><strong>' + money(state.amount) + '</strong></div><div class="review-row"><span>Rate</span><strong>' + lender.rate + ' fixed</strong></div><div class="review-row"><span>Term</span><strong>' + lender.term + '</strong></div><div class="review-row"><span>Valid until</span><strong>Oct 28, 2026, 12:00 PM</strong></div></div><div class="review-assurance">' + svg.shield + '<span>Submitting sends an attested credit request to the selected lender.</span></div><button class="primary-button modal-action" data-action="submit-request">Submit request</button>';
  } else {
    body = '<div class="status-success"><span class="success-icon">' + svg.verified + '</span><h3>Credit request submitted</h3><p>Your request is under review. You’ll be notified once the lender makes a decision.</p></div><div class="status-box"><div class="status-row"><span>Attestation status</span><strong><span class="pending-badge">PENDING</span></strong></div><div class="status-row"><span>Request ID</span><strong>#CR-29481</strong></div><div class="status-row"><span>Valid until</span><strong>Oct 28, 2026, 12:00 PM</strong></div></div><button class="secondary-button" data-action="view-details">View details</button>';
  }
  modalRoot.innerHTML = '<div class="modal-backdrop" data-action="backdrop"><section class="borrow-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-header"><div><p class="modal-eyebrow">Borrowing flow · page 2</p><h2 class="modal-title" id="modalTitle">' + titles[step] + '</h2></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">' + svg.close + '</button></div><div class="stepper" aria-label="Borrowing progress">' + steps + '</div>' + body + '</section></div>';
}

function render() {
  renderSidebar();
  main.innerHTML = state.page === "browse" ? renderBrowse() : state.page === "portfolio" ? renderPortfolio() : renderCollateral();
  if (state.helpOpen && state.page === "browse") main.insertAdjacentHTML("beforeend", '<aside class="help-popover"><h3>How lending rates work</h3><p>Rates and terms are set by each lender. Compare the fixed annual rate, origination fee, and repayment period before choosing an offer.</p></aside>');
  renderModal();
  document.getElementById("menuToggle").setAttribute("aria-label", state.sidebarOpen ? "Close navigation" : "Open navigation");
}
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
function actionFrom(target) { return target.closest("[data-action]"); }

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    state.page = pageButton.dataset.page;
    state.sidebarOpen = false;
    state.helpOpen = false;
    render();
    return;
  }
  const actionButton = actionFrom(event.target);
  if (!actionButton) {
    if (state.assetMenuOpen && !event.target.closest(".asset-select-wrap")) { state.assetMenuOpen = false; render(); }
    if (state.helpOpen && !event.target.closest(".help-popover") && !event.target.closest('[data-action="help"]')) { state.helpOpen = false; render(); }
    return;
  }
  const action = actionButton.dataset.action;
  if (action === "menu") { state.sidebarOpen = !state.sidebarOpen; render(); }
  else if (action === "wallet") { state.walletConnected = !state.walletConnected; render(); showToast(state.walletConnected ? "Wallet connected" : "Wallet disconnected"); }
  else if (action === "notifications") showToast("You’re all caught up");
  else if (action === "help") { state.helpOpen = !state.helpOpen; render(); }
  else if (action === "borrow") { state.selectedLender = actionButton.dataset.lender; state.modalStep = 2; state.amount = "50000"; render(); }
  else if (action === "close-modal") { state.modalStep = 0; render(); }
  else if (action === "backdrop" && event.target === actionButton) { state.modalStep = 0; render(); }
  else if (action === "change-lender") { state.modalStep = 1; render(); }
  else if (action === "choose-lender") { state.selectedLender = actionButton.dataset.lender; render(); }
  else if (action === "next-step") { state.modalStep = Math.min(3, state.modalStep + 1); render(); }
  else if (action === "submit-request") { state.modalStep = 4; render(); }
  else if (action === "view-details") { state.modalStep = 0; state.page = "portfolio"; state.sidebarOpen = true; render(); }
  else if (action === "borrow-max") { state.amount = "200000"; render(); }
  else if (action === "asset-menu") { state.assetMenuOpen = !state.assetMenuOpen; render(); }
  else if (action === "select-asset") { state.selectedAsset = actionButton.dataset.asset; state.depositAmount = ""; state.assetMenuOpen = false; render(); }
  else if (action === "deposit-max") { state.depositAmount = String(assets[state.selectedAsset].balance); render(); }
  else if (action === "deposit") showToast("Demo preview · no transaction was sent");
  else if (action === "view-all") showToast("All positions are shown");
});

document.addEventListener("input", (event) => {
  if (event.target.id === "borrowAmount") {
    state.amount = event.target.value;
    const message = modalRoot.querySelector(".info-banner span");
    if (message) message.textContent = "This request would use " + Math.min(100, Math.round((Number(state.amount) || 0) / 2000)) + "% of your available credit and keep your health factor at 1.8.";
    const next = modalRoot.querySelector('[data-action="next-step"]');
    if (next) next.disabled = !(Number(state.amount) > 0 && Number(state.amount) <= 200000);
  } else if (event.target.id === "depositAmount") {
    state.depositAmount = event.target.value;
    const cursor = event.target.selectionStart;
    const updated = renderCollateral();
    main.innerHTML = updated;
    const input = document.getElementById("depositAmount");
    input.focus();
    if (cursor !== null) input.setSelectionRange(cursor, cursor);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (state.modalStep) { state.modalStep = 0; render(); }
    else if (state.assetMenuOpen) { state.assetMenuOpen = false; render(); }
    else if (state.sidebarOpen) { state.sidebarOpen = false; render(); }
    else if (state.helpOpen) { state.helpOpen = false; render(); }
  }
});

const menuToggle = document.getElementById("menuToggle");
menuToggle.addEventListener("click", () => { state.sidebarOpen = !state.sidebarOpen; render(); });
render();
