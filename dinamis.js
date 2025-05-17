const { codeqr } = require('./config.json');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs').promises;

function toCRC16(str) {
  function charCodeAt(str, i) {
    let get = str.substr(i, 1);
    return get.charCodeAt();
  }

  let crc = 0xFFFF;
  let strlen = str.length;
  for (let c = 0; c < strlen; c++) {
    crc ^= charCodeAt(str, c) << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  hex = crc & 0xFFFF;
  hex = hex.toString(16);
  hex = hex.toUpperCase();
  if (hex.length == 3) {
    hex = "0" + hex;
  }
  return hex;
}

async function qrisDinamis(nominal, path) {
  nominal = nominal.toString();
  let qris = codeqr;

  let qris2 = qris.slice(0, -4);
  let replaceQris = qris2.replace("010211", "010212");
  let pecahQris = replaceQris.split("5802ID");
  let uang = "54" + ("0" + nominal.length).slice(-2) + nominal + "5802ID";

  let output = pecahQris[0] + uang + pecahQris[1] + toCRC16(pecahQris[0] + uang + pecahQris[1]);

  console.log("🔧 QR Dibuat untuk:", nominal);
  console.log("🧾 Final QR String:", output);

  // Generate QR code to a temporary buffer
  const qrBuffer = await QRCode.toBuffer(output, { margin: 2, scale: 10 });

  // Load the QR code image into a canvas
  const image = await loadImage(qrBuffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');

  // Draw the QR code on the canvas
  ctx.drawImage(image, 0, 0);

  // Add watermark
  ctx.font = 'bold 20px Arial'; // Adjust font size to be small enough
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'; // White with slight transparency
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('XSTBOT', canvas.width / 2, canvas.height / 2);

  // Save the final image
  const buffer = canvas.toBuffer('image/png');
  await fs.writeFile(path, buffer);

  return path;
}

module.exports = { qrisDinamis };
