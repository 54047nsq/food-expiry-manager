const form = document.querySelector("#food-form");
const productNameInput = document.querySelector("#product-name");
const expiryDateInput = document.querySelector("#expiry-date");
const foodList = document.querySelector("#food-list");
const emptyState = document.querySelector("#empty-state");
const itemCount = document.querySelector("#item-count");
const scanButton = document.querySelector("#scan-button");
const stopScanButton = document.querySelector("#stop-scan-button");
const scanner = document.querySelector("#scanner");
const cameraPreview = document.querySelector("#camera-preview");
const scanStatus = document.querySelector("#scan-status");

const PRODUCT_CSV_PATH = "商品データ(20260815154701).csv";
const productNamesByCode = new Map();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

async function loadProductCatalog() {
  const response = await fetch(encodeURI(PRODUCT_CSV_PATH), { cache: "no-cache" });
  if (!response.ok) throw new Error("Product CSV could not be loaded");

  const rows = parseCsv(await response.text());
  const headers = rows.shift()?.map((header) => header.trim()) || [];
  const codeColumn = Math.max(headers.indexOf("商品コード"), 1);
  const nameColumn = Math.max(headers.indexOf("商品名"), 2);

  rows.forEach((row) => {
    const code = row[codeColumn]?.trim();
    const name = row[nameColumn]?.trim();
    if (code && name) productNamesByCode.set(code, name);
  });
}

const productCatalogPromise = loadProductCatalog();

const foods = [];
let cameraStream = null;
let scanTimer = null;
let isDetecting = false;
let zxingControls = null;

function calculateDaysLeft(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  const expiryDate = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((expiryDate - today) / millisecondsPerDay);
}

function createStatusText(daysLeft) {
  if (daysLeft > 0) return `あと${daysLeft}日`;
  if (daysLeft === 0) return "本日が賞味期限です";
  return `賞味期限を${Math.abs(daysLeft)}日過ぎています`;
}

function formatDate(dateText) {
  const [year, month, day] = dateText.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function renderFoods() {
  foodList.replaceChildren();

  foods.forEach((food) => {
    const daysLeft = calculateDaysLeft(food.expiryDate);
    const listItem = document.createElement("li");
    const details = document.createElement("div");
    const name = document.createElement("div");
    const date = document.createElement("div");
    const status = document.createElement("div");

    listItem.className = "food-item";
    name.className = "food-name";
    date.className = "food-date";
    status.className = "days-left";

    name.textContent = food.name;
    date.textContent = `賞味期限：${formatDate(food.expiryDate)}`;
    status.textContent = createStatusText(daysLeft);

    if (daysLeft < 0) status.classList.add("expired");

    details.append(name, date);
    listItem.append(details, status);
    foodList.append(listItem);
  });

  emptyState.hidden = foods.length > 0;
  itemCount.textContent = `${foods.length}件`;
}

function stopScanner() {
  if (scanTimer) cancelAnimationFrame(scanTimer);
  scanTimer = null;
  isDetecting = false;

  if (zxingControls) {
    zxingControls.stop();
    zxingControls = null;
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  cameraPreview.srcObject = null;
  scanner.hidden = true;
  scanButton.disabled = false;
}

async function fillProductName(barcode) {
  scanStatus.textContent = `バーコード ${barcode} を読み取りました。商品情報を確認しています…`;

  try {
    await productCatalogPromise;
    const csvProductName = productNamesByCode.get(String(barcode).trim());

    if (csvProductName) {
      productNameInput.value = csvProductName;
      scanStatus.textContent = "「" + csvProductName + "」を商品名に入力しました。";
      productNameInput.focus();
      return;
    }

    const endpoint = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name_ja,product_name,brands`;
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error("Product lookup failed");

    const data = await response.json();
    const product = data.product || {};
    const productName = product.product_name_ja || product.product_name || product.brands;

    if (productName) {
      productNameInput.value = productName.trim();
      scanStatus.textContent = `「${productNameInput.value}」を商品名に入力しました。`;
    } else {
      productNameInput.value = `バーコード ${barcode}`;
      scanStatus.textContent = "商品名が見つからなかったため、バーコード番号を入力しました。必要に応じて修正してください。";
    }
  } catch (error) {
    productNameInput.value = `バーコード ${barcode}`;
    scanStatus.textContent = "商品情報を取得できなかったため、バーコード番号を入力しました。インターネット接続を確認してください。";
  }

  productNameInput.focus();
}

async function startScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    scanStatus.textContent = "リアルタイム読み取りにはHTTPSが必要です。HTTPSのURLで開いてください。";
    return;
  }

  if (!("BarcodeDetector" in window)) {
    await startZxingScanner();
    return;
  }

  try {
    scanButton.disabled = true;
    scanStatus.textContent = "カメラを起動しています…";
    const supportedFormats = await BarcodeDetector.getSupportedFormats();
    const preferredFormats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];
    const formats = preferredFormats.filter((format) => supportedFormats.includes(format));
    const detector = new BarcodeDetector(formats.length ? { formats } : undefined);

    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    cameraPreview.srcObject = cameraStream;
    scanner.hidden = false;
    await cameraPreview.play();
    scanStatus.textContent = "バーコードを枠の中央に合わせてください。";

    const detectFrame = async () => {
      if (!cameraStream) return;

      if (!isDetecting && cameraPreview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        isDetecting = true;
        try {
          const barcodes = await detector.detect(cameraPreview);
          if (barcodes.length > 0) {
            const barcode = barcodes[0].rawValue;
            stopScanner();
            await fillProductName(barcode);
            return;
          }
        } catch (error) {
          scanStatus.textContent = "読み取り中です。バーコードを明るい場所で枠に合わせてください。";
        } finally {
          isDetecting = false;
        }
      }

      scanTimer = requestAnimationFrame(detectFrame);
    };

    detectFrame();
  } catch (error) {
    stopScanner();
    scanStatus.textContent = "カメラを起動できませんでした。ブラウザのカメラ許可を確認してください。";
  }
}

async function startZxingScanner() {
  if (!window.ZXingBrowser) {
    scanStatus.textContent = "読み取り機能を読み込めませんでした。インターネット接続を確認して、もう一度お試しください。";
    return;
  }

  try {
    scanButton.disabled = true;
    scanner.hidden = false;
    scanStatus.textContent = "カメラを起動しています…";
    const reader = new ZXingBrowser.BrowserMultiFormatReader();
    let hasResult = false;

    const controls = await reader.decodeFromConstraints(
      {
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      },
      cameraPreview,
      async (result, error, activeControls) => {
        if (!result || hasResult) return;
        hasResult = true;
        const barcode = result.getText();
        activeControls.stop();
        stopScanner();
        await fillProductName(barcode);
      },
    );
    if (hasResult) {
      controls.stop();
      return;
    }
    zxingControls = controls;
    scanStatus.textContent = "バーコードを枠の中央に合わせてください。自動で読み取ります。";
  } catch (error) {
    stopScanner();
    scanStatus.textContent = "カメラを起動できませんでした。HTTPSで開き、ブラウザのカメラ許可を確認してください。";
  }
}

scanButton.addEventListener("click", startScanner);
stopScanButton.addEventListener("click", () => {
  stopScanner();
  scanStatus.textContent = "バーコード読み取りを中止しました。";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  foods.push({
    name: productNameInput.value.trim(),
    expiryDate: expiryDateInput.value,
  });

  renderFoods();
  form.reset();
  productNameInput.focus();
});

window.addEventListener("pagehide", stopScanner);
renderFoods();
