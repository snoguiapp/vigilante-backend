const mqtt = require('mqtt');
const { Expo } = require('expo-server-sdk');


const express = require('express');
const ExcelJS = require('exceljs');
const app = express();
const cors = require('cors');
app.use(cors()); // Esto permite que la App se conecte al servidor
const port = 3000; // El puerto donde escuchará tu servidor


// --- CONFIGURACIÓN ---
// Aquí pones tu token para que el servidor sepa a qué celular avisarle
const pushToken = 'ExponentPushToken[fhA3apCHA_HLZUYcMdUiDr]'; 

// Iniciamos la herramienta de Expo
const expo = new Expo();

// Variables para no hacer "spam" de notificaciones cada segundo
let avisoLlenoEnviado = false;
let avisoBajoEnviado = false;

// Nos conectamos al broker MQTT (usamos el puerto 1883 estándar para Node.js)
const brokerUrl = 'mqtt://broker.emqx.io:1883';
// Cambia esto:
// const client = mqtt.connect(brokerUrl);

// Agregamos un número aleatorio al final del nombre para que NUNCA choque

const mongoose = require('mongoose');

// Reemplaza <password> con tu contraseña real y asegúrate de que no haya espacios
const mongoURI = 'mongodb://AdminCisterna:kNYhNNAyoOAusSpm@ac-ql84vzv-shard-00-00.rassssp.mongodb.net:27017,ac-ql84vzv-shard-00-01.rassssp.mongodb.net:27017,ac-ql84vzv-shard-00-02.rassssp.mongodb.net:27017/?ssl=true&replicaSet=atlas-x64bzt-shard-0&authSource=admin&appName=ClusterCisterna'; 

mongoose.connect(mongoURI)
  .then(() => console.log('✅ Conectado exitosamente a MongoDB Atlas'))
  .catch(err => console.error('❌ Error al conectar a MongoDB:', err));
const opcionesMqtt = {
    clientId: 'VigilanteBackend_' + Math.random().toString(16).substring(2, 10)
};

const lecturaSchema = new mongoose.Schema({
  dispositivo: String, // Ejemplo: "UACH1"
  nivel: Number,       // Ejemplo: 80
  estadoBomba: String, // Ejemplo: "Encendida"
  fecha: { type: Date, default: Date.now } // Se pone sola la hora actual
});

// Creamos el modelo (la "tabla" donde se guardará todo)
const Lectura = mongoose.model('Lectura', lecturaSchema);


const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', opcionesMqtt);

console.log('Iniciando el Vigilante Backend...');

client.on('connect', () => {
    console.log('✅ Conectado al MQTT exitosamente.');
    // Nos suscribimos al tanque
    client.subscribe('UACH1/nivel_tanque');
    console.log('👀 Vigilando el tópico: UACH1/nivel_tanque');
});

client.on('message', (topic, message) => {
    if (topic === 'UACH1/nivel_tanque') {
        const nivel = parseInt(message.toString());
        console.log(`💧 Nivel actual de la cisterna: ${nivel}%`);

        // --- 1. CORRECCIÓN: ESTADO DE LA BOMBA PARA MONGO Y EXCEL ---
        let estadoBombaActual = "Estable"; 
        
        // Invertimos la lógica según lo que ves en tu monitor:
        if (nivel <= 25) {
            estadoBombaActual = "Apagada"; // Si antes decía Encendida, ahora dice Apagada
        } else if (nivel >= 95) {
            estadoBombaActual = "Encendida"; // Si antes decía Apagada, ahora dice Encendida
        }

        const nuevaLectura = new Lectura({
            dispositivo: 'UACH1',
            nivel: nivel,
            estadoBomba: estadoBombaActual
        });

        nuevaLectura.save()
            .then(() => console.log(`💾 Guardado en DB: ${nivel}% - Bomba: ${estadoBombaActual}`))
            .catch(err => console.error('❌ Error al guardar:', err));
        // ----------------------------------------------------------

        // --- 2. LÓGICA DE NOTIFICACIONES ---
        if (nivel >= 95 && !avisoLlenoEnviado) {
            enviarNotificacion("¡Cisterna Llena! 🌊", "Nivel al máximo.");
            avisoLlenoEnviado = true;
            avisoBajoEnviado = false;
        } 
        else if (nivel <= 25 && !avisoBajoEnviado) {
            enviarNotificacion("¡Nivel Crítico! 🚨", `Nivel bajo (${nivel}%).`);
            avisoBajoEnviado = true;
            avisoLlenoEnviado = false;
        } 
        else if (nivel > 30 && nivel < 90) {
            avisoLlenoEnviado = false;
            avisoBajoEnviado = false;
        }
    }
});

// RUTA PARA DESCARGAR REPORTE SEMANAL
app.get('/reporte-semanal', async (req, res) => {
    try {
        // 1. Calculamos la fecha de hace 7 días
        const unaSemanaAtras = new Date();
        unaSemanaAtras.setDate(unaSemanaAtras.getDate() - 7);

        // 2. Buscamos los datos en MongoDB
        const datos = await Lectura.find({
            fecha: { $gte: unaSemanaAtras }
        }).sort({ fecha: -1 }); // Del más reciente al más antiguo

        // 3. Creamos el libro de Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte Semanal');

        // 4. Definimos las columnas
        worksheet.columns = [
            { header: 'Fecha y Hora', key: 'fecha', width: 25 },
            { header: 'Dispositivo', key: 'dispositivo', width: 15 },
            { header: 'Nivel (%)', key: 'nivel', width: 12 },
            { header: 'Estado de Bomba', key: 'estado', width: 18 }
        ];

        // 5. Llenamos las filas con los datos de la DB
        datos.forEach(item => {
            worksheet.addRow({
                fecha: item.fecha.toLocaleString(), // Formato legible
                dispositivo: item.dispositivo,
                nivel: item.nivel,
                estado: item.estadoBomba
            });
        });

        // 6. Estilo profesional (Negritas en el encabezado)
        worksheet.getRow(1).font = { bold: true };

        // 7. Enviamos el archivo al navegador
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Reporte_Semanal_Cisterna.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al generar Excel:', error);
        res.status(500).send('Error al generar el reporte');
    }
});

// Iniciamos el servidor Express
app.listen(port, () => {
    console.log(`🚀 Servidor web listo en http://localhost:${port}`);
});

// --- FUNCIÓN QUE ENVÍA LA ALERTA A EXPO ---
async function enviarNotificacion(titulo, cuerpo) {
    // Verificamos que el token tenga el formato correcto
    if (!Expo.isExpoPushToken(pushToken)) {
        console.error(`❌ El token no es válido: ${pushToken}`);
        return;
    }

   // Armamos el paquete de la notificación
    const messages = [{
        to: pushToken,
        sound: 'default',
        title: titulo,
        body: cuerpo,
        priority: 'high',
        channelId: 'default',        // <-- Esto ayuda a Android a clasificarla
        data: { origen: 'backend' }  // <-- Esto evita que Android la silencie por estar vacía
    }];

    try {
        // Le pedimos a los servidores de Expo que se la manden a tu Android
        let chunks = expo.chunkPushNotifications(messages);
        for (let chunk of chunks) {
            let ticket = await expo.sendPushNotificationsAsync(chunk);
            console.log('📨 Alerta enviada a tu celular:', ticket);
        }
    } catch (error) {
        console.error('❌ Error enviando notificación:', error);
    }
}