**Use:**

```
(async () => {
  pdfLayer = await addPdfLayerToMap(map, "Name", {
    pdfUrl: pdfUrl, // Url to PDF file
    pgwUrl: pgwUrl, // Url to .pgw file
    imageWidth: imageWidth, //Width of referenced image .pgw
    imageHeight: imageHeight, //Height of referenced image .pgw
    opacity: 1, // 1 - default
    beforeId: "building", // Upper layer
  });
})();

pdfLayer.enable(); 
pdfLayer.disable();
pdfLayer.remove();
pdfLayer.setOpacity(0.2); 
pdfLayer.moveAbove("roads");
