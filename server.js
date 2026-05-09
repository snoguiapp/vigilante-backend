require('dotenv').config(); // Carga las variables del archivo .env
const mqtt = require('mqtt');
const { Expo } = require('expo-server-sdk');
const express = require('express');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURACIÓN DESDE VARIABLES DE ENTORNO ---
const PORT = process.env.PORT || 3000;
const mongoURI = process.env.MONGO_URI;
const pushToken = process.env.EXPO_PUSH_TOKEN;

const expo = new Expo();
let avisoLlenoEnviado = false;
let avisoBajoEnviado = false;

// --- CONEXIÓN BASE DE DATOS ---
mongoose.connect(mongoURI)
  .then(() => console.log('✅ Conectado exitosamente a MongoDB Atlas'))
  .catch(err => console.error('❌ Error al conectar a MongoDB:', err));

const lecturaSchema = new mongoose.Schema({
  dispositivo: String,
  nivel: Number,
  estadoBomba: String,
  fecha: { type: Date, default: Date.now }
});

const Lectura = mongoose.model('Lectura', lecturaSchema);

// --- CONFIGURACIÓN MQTT ---
const opcionesMqtt = {
  clientId: 'VigilanteBackend_' + Math.random().toString(16).substring(2, 10)
};

const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', opcionesMqtt);

client.on('connect', () => {
  console.log('✅ Conectado al MQTT exitosamente.');
  client.subscribe('UACH1/nivel_tanque');
});

client.on('message', async (topic, message) => {
  if (topic === 'UACH1/nivel_tanque') {
    const nivel = parseInt(message.toString());
    const ahora = new Date();
    
    if (typeof global.ultimoGuardado === 'undefined') global.ultimoGuardado = new Date(0);
    const diferenciaHoras = (ahora - global.ultimoGuardado) / (1000 * 60 * 60);

    let debeGuardar = diferenciaHoras >= 1 || nivel <= 25 || nivel >= 100;
    let estadoBombaActual = nivel <= 25 ? "Apagada" : (nivel >= 95 ? "Encendida" : "Estable");

    if (debeGuardar) {
      try {
        const nuevaLectura = new Lectura({ dispositivo: 'UACH1', nivel, estadoBomba: estadoBombaActual });
        await nuevaLectura.save();
        global.ultimoGuardado = ahora;
        console.log(`💾 Guardado: ${nivel}%`);
      } catch (e) { console.error("Error DB:", e); }
    }

    // Lógica de Notificaciones
    if (nivel >= 95 && !avisoLlenoEnviado) {
      enviarNotificacion("¡Cisterna Llena! 🌊", "Nivel al máximo.");
      avisoLlenoEnviado = true; avisoBajoEnviado = false;
    } else if (nivel <= 25 && !avisoBajoEnviado) {
      enviarNotificacion("¡Nivel Crítico! 🚨", `Nivel bajo (${nivel}%).`);
      avisoBajoEnviado = true; avisoLlenoEnviado = false;
    } else if (nivel > 30 && nivel < 90) {
      avisoLlenoEnviado = false; avisoBajoEnviado = false;
    }
  }
});

// --- RUTAS ---
app.get('/reporte-semanal', async (req, res) => {
  try {
    const unaSemanaAtras = new Date();
    unaSemanaAtras.setDate(unaSemanaAtras.getDate() - 7);
    const datos = await Lectura.find({ fecha: { $gte: unaSemanaAtras } }).sort({ fecha: -1 });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte');
    worksheet.columns = [
      { header: 'Fecha y Hora', key: 'fecha', width: 25 },
      { header: 'Nivel (%)', key: 'nivel', width: 12 },
      { header: 'Estado Bomba', key: 'estado', width: 18 }
    ];

    datos.forEach(item => {
      worksheet.addRow({ fecha: item.fecha.toLocaleString(), nivel: item.nivel, estado: item.estadoBomba });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Reporte.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) { res.status(500).send('Error'); }
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});

async function enviarNotificacion(titulo, cuerpo) {
  if (!Expo.isExpoPushToken(pushToken)) return;
  const messages = [{ to: pushToken, sound: 'default', title: titulo, body: cuerpo }];
  try {
    let chunks = expo.chunkPushNotifications(messages);
    for (let chunk of chunks) { await expo.sendPushNotificationsAsync(chunk); }
  } catch (e) { console.error(e); }
}