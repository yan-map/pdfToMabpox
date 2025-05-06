//required:    
//<script type="module">import pdfjsDist from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.2.133/+esm'</script>
//<script>pdfjsLib.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@5.2.133/build/pdf.worker.min.mjs";</script>
//<script src="https://cdn.jsdelivr.net/npm/proj4@2.15.0/dist/proj4.min.js"></script>

export async function addPdfLayerToMap(
  map,
  name,
  {
    pdfUrl: pdfUrl,
    pgwUrl: pgwUrl,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    opacity: pdfOpacity = 1, // ← fallback значение
    beforeId: beforeId,
  }
) {
  let loadedPGW = null;
  let pgwPt = null;
  let loadedPDF = null;
  let pdfWidthPt = null;
  let pdfHeightPt = null;
  const imageId = name;

  // --- Утилиты ---
  function lngLatToMercator([lng, lat]) {
    const R = 6378137;
    const x = (R * lng * Math.PI) / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    return [x, y];
  }

  function mercatorToPdfPt(xm, ym, pgwPt) {
    const { A, B, D, E, C, F } = pgwPt;
    const det = A * E - B * D;
    const invA = E / det;
    const invB = -B / det;
    const invD = -D / det;
    const invE = A / det;
    const dx = xm - C;
    const dy = ym - F;
    const x = invA * dx + invB * dy;
    const y = invD * dx + invE * dy;
    return [x, y];
  }

  function pdfPtToMercator(xPt, yPt, pgwPt) {
    const { A, B, D, E, C, F } = pgwPt;
    const X = A * xPt + B * yPt + C;
    const Y = D * xPt + E * yPt + F;
    return [X, Y];
  }

  function mercatorToWgs84([x, y]) {
    return proj4("EPSG:3857", "EPSG:4326", [x, y]);
  }

  function clipBBoxToPage(bbox, pageWidth, pageHeight) {
    const x1 = bbox.x;
    const y1 = bbox.y;
    const x2 = bbox.x + bbox.width;
    const y2 = bbox.y + bbox.height;
    if (x2 < 0 || y2 < 0 || x1 > pageWidth || y1 > pageHeight) return null;
    const x = Math.max(0, x1);
    const y = Math.max(0, y1);
    const maxX = Math.min(pageWidth, x2);
    const maxY = Math.min(pageHeight, y2);
    return { x, y, width: maxX - x, height: maxY - y };
  }

  function getExpandedPdfBBox(map, pgwPt) {
    const bounds = map.getBounds();
    const cornersWGS = [
      [bounds.getWest(), bounds.getSouth()],
      [bounds.getEast(), bounds.getSouth()],
      [bounds.getEast(), bounds.getNorth()],
      [bounds.getWest(), bounds.getNorth()],
    ];
    const corners3857 = cornersWGS.map(lngLatToMercator);
    const cornersPDF = corners3857.map(([x, y]) =>
      mercatorToPdfPt(x, y, pgwPt)
    );
    const xs = cornersPDF.map((p) => p[0]);
    const ys = cornersPDF.map((p) => p[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  function calculateCanvasSize(clippedBBox, pgwPt, map) {
    const zoom = map.getZoom();
    const dpr = window.devicePixelRatio || 1;
    const metersPerPixel = 40075016.68557849 / Math.pow(2, zoom) / 512;

    const dx = pgwPt.A * clippedBBox.width + pgwPt.B * clippedBBox.height;
    const dy = pgwPt.D * clippedBBox.width + pgwPt.E * clippedBBox.height;

    const widthMeters = dx;
    const heightMeters = dy;

    const scaleX = Math.hypot(pgwPt.A, pgwPt.D);
    const scaleY = Math.hypot(pgwPt.B, pgwPt.E);
    const distortionFactor = 1 + Math.max(scaleX, scaleY);

    const widthPx =
      Math.abs(widthMeters / metersPerPixel) * dpr * distortionFactor;
    const heightPx =
      Math.abs(heightMeters / metersPerPixel) * dpr * distortionFactor;

    const maxSize = 4096;
    return {
      width: Math.min(Math.ceil(widthPx), maxSize),
      height: Math.min(Math.ceil(heightPx), maxSize),
    };
  }

  // --- Загрузка PDF ---
  loadedPDF = await pdfjsLib.getDocument(pdfUrl).promise;
  const page = await loadedPDF.getPage(1);
  pdfWidthPt = page.view[2];
  pdfHeightPt = page.view[3];

  // --- Загрузка PGW и пересчёт ---
  const text = await fetch(pgwUrl).then((res) => res.text());
  const lines = text.trim().split(/\r?\n/).map(parseFloat);
  if (lines.length !== 6) throw new Error("Invalid PGW");

  loadedPGW = {
    A: lines[0],
    D: lines[1],
    B: lines[2],
    E: lines[3],
    C: lines[4],
    F: lines[5],
  };

  const widthMeters = loadedPGW.A * imageWidth;
  const heightMeters = Math.abs(loadedPGW.E * imageHeight);
  let scaleX = pdfWidthPt / widthMeters;
  let scaleY = pdfHeightPt / heightMeters;

  pgwPt = {
    A: loadedPGW.A * scaleX,
    B: loadedPGW.B * scaleX,
    D: loadedPGW.D * scaleY,
    E: loadedPGW.E * scaleY,
    C: loadedPGW.C,
    F: loadedPGW.F,
  };

  const redWidth = loadedPGW.A * imageWidth;
  const blueWidth = pgwPt.A * pdfWidthPt;
  const correctionFactor = redWidth / blueWidth;
  pgwPt.A *= correctionFactor;
  pgwPt.B *= correctionFactor;
  pgwPt.D *= correctionFactor;
  pgwPt.E *= correctionFactor;

  // --- Основной рендер ---
  async function addPdfToMap() {
    if (!visible) return; // 🔒 Не рендерим, если слой выключен

    const expandedBBoxPt = getExpandedPdfBBox(map, pgwPt);
    const clippedBBox = clipBBoxToPage(expandedBBoxPt, pdfWidthPt, pdfHeightPt);
    if (!clippedBBox) return;

    const { width, height } = calculateCanvasSize(clippedBBox, pgwPt, map);
    const scaleX = width / clippedBBox.width;
    const scaleY = height / clippedBBox.height;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    await page.render({
      canvasContext: ctx,
      viewport: page.getViewport({ scale: 1 }),
      transform: [
        scaleX,
        0,
        0,
        scaleY,
        -clippedBBox.x * scaleX,
        -clippedBBox.y * scaleY,
      ],
      background: "rgba(0,0,0,0)", // ← прозрачный фон!
    }).promise;

    const bitmap = await createImageBitmap(canvas);

    if (map.hasImage(imageId)) map.removeImage(imageId);
    map.addImage(imageId, bitmap, { pixelRatio: 1 });

    if (map.getSource(imageId)) {
      map.removeLayer(imageId);
      map.removeSource(imageId);
    }

    const tl = mercatorToWgs84(
      pdfPtToMercator(clippedBBox.x, clippedBBox.y, pgwPt)
    );
    const tr = mercatorToWgs84(
      pdfPtToMercator(clippedBBox.x + clippedBBox.width, clippedBBox.y, pgwPt)
    );
    const br = mercatorToWgs84(
      pdfPtToMercator(
        clippedBBox.x + clippedBBox.width,
        clippedBBox.y + clippedBBox.height,
        pgwPt
      )
    );
    const bl = mercatorToWgs84(
      pdfPtToMercator(clippedBBox.x, clippedBBox.y + clippedBBox.height, pgwPt)
    );

    map.addSource(imageId, {
      type: "image",
      url: canvas.toDataURL(),
      coordinates: [tl, tr, br, bl],
    });

    map.addLayer(
      {
        id: imageId,
        source: imageId,
        type: "raster",
        paint: {
          "raster-opacity": pdfOpacity,
        },
      },
      beforeId
    );
  }

  // Первый вызов
  //await addPdfToMap();

  // Обновление при перемещении
  map.on("moveend", addPdfToMap);

  let visible = false;
  let isRemoved = false;

  const pdfControl = {
    enable: () => {
      visible = true;
      if (isRemoved) {
        map.on("moveend", addPdfToMap);
        isRemoved = false;
      }
      addPdfToMap();
    },
    disable: () => {
      visible = false;
      if (map.getLayer(imageId)) map.removeLayer(imageId);
      if (map.getSource(imageId)) map.removeSource(imageId);
    },
    remove: () => {
      visible = false;
      isRemoved = true;
      if (map.hasImage(imageId)) map.removeImage(imageId);
      if (map.getLayer(imageId)) map.removeLayer(imageId);
      if (map.getSource(imageId)) map.removeSource(imageId);
      map.off("moveend", addPdfToMap);
    },
    isEnabled: () => visible,
    setOpacity: (value) => {
      pdfOpacity = value;
      if (map.getLayer(imageId)) {
        map.setPaintProperty(imageId, "raster-opacity", pdfOpacity);
      }
    },
    moveBelow: (targetLayerId) => {
      if (map.getLayer(imageId) && map.getLayer(targetLayerId)) {
        map.moveLayer(imageId, targetLayerId);
      }
    },
  };

  pdfControl.enable();

  return pdfControl;
}
