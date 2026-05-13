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
// CAMBIO 1: Ya no usamos banderas simples (avisoLlenoEnviado /
// avisoBajoEnviado). Ahora guardamos el TIMESTAMP de la última
// notificación enviada para cada estado, lo que nos permite
// controlar intervalos de tiempo en lugar de solo "ya avisé / no avisé".
// ─────────────────────────────────────────────────────────────
let ultimaNotifBajo    = null; // Fecha del último aviso de nivel bajo (<=25)
let ultimaNotifLleno   = null; // Fecha del último aviso de cisterna llena (>=100)
let ultimaNotifEstable = null; // Fecha del último aviso de nivel estable (26–99)

// Intervalos de repetición
const INTERVALO_CRITICO_MS = 15 * 60 * 1000; // 15 minutos en milisegundos
const INTERVALO_ESTABLE_MS = 60 * 60 * 1000; // 1 hora en milisegundos

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

app.post('/registrar-token', async (req, res) => {
  const { token, dispositivoId } = req.body;
  if (!token) return res.status(400).send('Falta el token');
  try {
    await Usuario.findOneAndUpdate(
      { expoPushToken: token },
      { dispositivoId: dispositivoId },
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

    // ─────────────────────────────────────────────────────────────
    // CAMBIO 2: Nueva lógica de notificaciones con intervalos.
    //
    // Para cada estado se verifica si:
    //   a) Nunca se ha enviado una notificación (null), O
    //   b) Ya pasó el intervalo de tiempo correspondiente.
    //
    // Así se evita spamear al usuario y se repite el aviso
    // periódicamente mientras el nivel siga en ese rango.
    // ─────────────────────────────────────────────────────────────

    if (nivel <= 25) {
      // ESTADO CRÍTICO BAJO:
      // Primera vez: notifica de inmediato.
      // Siguientes: notifica cada 15 minutos mientras siga bajo.
      // Se resetea ultimaNotifLleno y ultimaNotifEstable para que
      // cuando salga del estado crítico vuelva a notificar fresco.
      const debeNotificar = !ultimaNotifBajo ||
        (ahora - ultimaNotifBajo) >= INTERVALO_CRITICO_MS;

      if (debeNotificar) {
        await enviarNotificacion(
          "¡Nivel Crítico! 🚨",
          `La cisterna está al ${nivel}%. ¡Se necesita agua!`
        );
        ultimaNotifBajo  = ahora;
        ultimaNotifLleno   = null; // Resetea el otro estado
        ultimaNotifEstable = null;
      }

    } else if (nivel >= 100) {
      // ESTADO LLENO:
      // Primera vez: notifica de inmediato.
      // Siguientes: notifica cada 15 minutos mientras siga lleno.
      const debeNotificar = !ultimaNotifLleno ||
        (ahora - ultimaNotifLleno) >= INTERVALO_CRITICO_MS;

      if (debeNotificar) {
        await enviarNotificacion(
          "¡Cisterna Llena! 🌊",
          `La cisterna está al ${nivel}%. Nivel al máximo.`
        );
        ultimaNotifLleno   = ahora;
        ultimaNotifBajo    = null; // Resetea el otro estado
        ultimaNotifEstable = null;
      }

    } else {
      // ESTADO ESTABLE (26–99):
      // Notifica una vez por hora para informar que todo está bien.
      // Al entrar a este rango se resetean los estados críticos para
      // que cuando vuelvan a ocurrir se notifique de inmediato.
      ultimaNotifBajo  = null;
      ultimaNotifLleno = null;

      const debeNotificar = !ultimaNotifEstable ||
        (ahora - ultimaNotifEstable) >= INTERVALO_ESTABLE_MS;

      if (debeNotificar) {
        await enviarNotificacion(
          "Nivel Normal ✅",
          `La cisterna está al ${nivel}%. Todo en orden.`
        );
        ultimaNotifEstable = ahora;
      }
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
  console.log(`🚀 Servidor en puerto ${PORT}`);
});

async function enviarNotificacion(titulo, cuerpo) {
  try {
    const usuarios = await Usuario.find();
    const tokens = usuarios.map(u => u.expoPushToken);
    if (tokens.length === 0) return;

    let messages = [];
    for (let pushToken of tokens) {
      if (!Expo.isExpoPushToken(pushToken)) continue;
      messages.push({
        to: pushToken,
        sound: 'default',
        title: titulo,
        body: cuerpo,
        priority: 'high'
      });
    }

    let chunks = expo.chunkPushNotifications(messages);
    for (let chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
    console.log(`📢 Alerta enviada a ${tokens.length} dispositivos: ${titulo}`);
  } catch (error) {
    console.error('❌ Error enviando notificaciones:', error);
  }
}