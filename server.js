require('dotenv').config();
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

const expo = new Expo();

// ─────────────────────────────────────────────────────────────
// INTERVALOS
// ─────────────────────────────────────────────────────────────
const INTERVALO_HORA  = 60 * 60 * 1000;   // 1 hora  → guardado y notif estable
const INTERVALO_15MIN = 15 * 60 * 1000;   // 15 min  → guardado y notif crítica

// ─────────────────────────────────────────────────────────────
// TIMESTAMPS — controlan cuándo se guardó o notificó por última vez
// Se usan en lugar de banderas booleanas para poder medir intervalos
// ─────────────────────────────────────────────────────────────
let ultimoGuardado     = new Date(0); // new Date(0) = nunca guardado
let ultimaNotifBajo    = null;        // Última notif nivel bajo   (<=25)
let ultimaNotifLleno   = null;        // Última notif nivel lleno  (>=100)
let ultimaNotifEstable = null;        // Última notif nivel estable (26-99)

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

const usuarioSchema = new mongoose.Schema({
  expoPushToken: { type: String, required: true, unique: true },
  dispositivoId: String,
  fechaRegistro: { type: Date, default: Date.now }
});
const Usuario = mongoose.model('Usuario', usuarioSchema);

// --- RUTA: Registrar token del celular ---
app.post('/registrar-token', async (req, res) => {
  const { token, dispositivoId } = req.body;
  if (!token) return res.status(400).send('Falta el token');
  try {
    await Usuario.findOneAndUpdate(
      { expoPushToken: token },
      { dispositivoId },
      { upsert: true, new: true }
    );
    console.log(`📱 Token registrado/actualizado: ${token}`);
    res.status(200).send('Token guardado exitosamente');
  } catch (error) {
    console.error('Error al guardar token:', error);
    res.status(500).send('Error interno');
  }
});

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
  if (topic !== 'UACH1/nivel_tanque') return;

  const nivel = parseInt(message.toString());
  if (isNaN(nivel)) return;

  const ahora = new Date();
  const esCritico = nivel <= 25 || nivel >= 100;

  // ─────────────────────────────────────────────────────────────
  // GUARDAR EN BASE DE DATOS
  //
  // Nivel crítico (<=25 o >=100): guarda cada 15 minutos
  // Nivel estable (26–99)       : guarda cada 1 hora
  //
  // Así el reporte siempre tiene los momentos importantes
  // sin llenar la DB con lecturas basura cada segundo.
  // ─────────────────────────────────────────────────────────────
  const msSinGuardar      = ahora - ultimoGuardado;
  const intervaloGuardado = esCritico ? INTERVALO_15MIN : INTERVALO_HORA;

  if (msSinGuardar >= intervaloGuardado) {
    const estadoBomba = nivel <= 25 ? 'Apagada' : nivel >= 95 ? 'Encendida' : 'Estable';
    try {
      await new Lectura({ dispositivo: 'UACH1', nivel, estadoBomba }).save();
      ultimoGuardado = ahora;
      console.log(`💾 Guardado → Nivel: ${nivel}% | Bomba: ${estadoBomba}`);
    } catch (e) {
      console.error('Error al guardar lectura:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // NOTIFICACIONES
  //
  // Estado BAJO (<=25):
  //   Primera notif: inmediata. Siguientes: cada 15 min.
  //
  // Estado LLENO (>=100):
  //   Primera notif: inmediata. Siguientes: cada 15 min.
  //
  // Estado ESTABLE (26–99):
  //   Notifica cada 1 hora para informar que todo está bien.
  //   Al entrar aquí se resetean los timestamps críticos para
  //   que la próxima alerta crítica salga de inmediato.
  // ─────────────────────────────────────────────────────────────
  if (nivel <= 25) {
    const debeNotificar = !ultimaNotifBajo ||
      (ahora - ultimaNotifBajo) >= INTERVALO_15MIN;

    if (debeNotificar) {
      await enviarNotificacion(
        '¡Nivel Crítico! 🚨',
        `La cisterna está al ${nivel}%. ¡Se necesita agua urgente!`
      );
      ultimaNotifBajo    = ahora;
      ultimaNotifLleno   = null;
      ultimaNotifEstable = null;
    }

  } else if (nivel >= 100) {
    const debeNotificar = !ultimaNotifLleno ||
      (ahora - ultimaNotifLleno) >= INTERVALO_15MIN;

    if (debeNotificar) {
      await enviarNotificacion(
        '¡Cisterna Llena! 🌊',
        `La cisterna está al ${nivel}%. Nivel al máximo, revisa la bomba.`
      );
      ultimaNotifLleno   = ahora;
      ultimaNotifBajo    = null;
      ultimaNotifEstable = null;
    }

  } else {
    // Volvió a nivel estable: resetea críticos para próxima alerta inmediata
    ultimaNotifBajo  = null;
    ultimaNotifLleno = null;

    const debeNotificar = !ultimaNotifEstable ||
      (ahora - ultimaNotifEstable) >= INTERVALO_HORA;

    if (debeNotificar) {
      await enviarNotificacion(
        'Nivel Normal ✅',
        `La cisterna está al ${nivel}%. Todo en orden.`
      );
      ultimaNotifEstable = ahora;
    }
  }
});

// --- RUTA: Reporte semanal en Excel ---
app.get('/reporte-semanal', async (req, res) => {
  try {
    const unaSemanaAtras = new Date();
    unaSemanaAtras.setDate(unaSemanaAtras.getDate() - 7);
    const datos = await Lectura.find({ fecha: { $gte: unaSemanaAtras } }).sort({ fecha: -1 });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte');
    worksheet.columns = [
      { header: 'Fecha y Hora', key: 'fecha', width: 25 },
      { header: 'Nivel (%)',    key: 'nivel', width: 12 },
      { header: 'Estado Bomba', key: 'estado', width: 18 }
    ];
    datos.forEach(item => {
      worksheet.addRow({
        fecha: item.fecha.toLocaleString(),
        nivel: item.nivel,
        estado: item.estadoBomba
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Reporte.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error generando reporte:', error);
    res.status(500).send('Error');
  }
});

// --- RUTA: Historial de lecturas ---
app.get('/historial/:dispositivoId', async (req, res) => {
  try {
    const { dispositivoId } = req.params;
    const lecturas = await Lectura.find({ dispositivoId })
      .sort({ fecha: -1 })
      .limit(24);
    res.json(lecturas.reverse());
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).send('Error al obtener datos');
  }
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});

// --- FUNCIÓN: Enviar notificación push a todos los dispositivos registrados ---
async function enviarNotificacion(titulo, cuerpo) {
  try {
    const usuarios = await Usuario.find();
    const tokens = usuarios.map(u => u.expoPushToken);
    if (tokens.length === 0) return;

    const messages = [];
    for (const pushToken of tokens) {
      if (!Expo.isExpoPushToken(pushToken)) continue;
      messages.push({
        to: pushToken,
        sound: 'default',
        title: titulo,
        body: cuerpo,
        priority: 'high'
      });
    }

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    console.log(`📢 Notificación enviada a ${tokens.length} dispositivo(s): "${titulo}"`);
  } catch (error) {
    console.error('❌ Error enviando notificaciones:', error);
  }
}
