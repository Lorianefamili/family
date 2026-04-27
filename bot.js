require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json');

// Init Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Init Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const POINTS_PAR_PUB = parseInt(process.env.POINTS_PAR_PUB) || 10;
const MINI_APP_URL = process.env.MINI_APP_URL;

// ─────────────────────────────────────────────
// COMMANDE /start
// ─────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;

  // Créer l'utilisateur s'il n'existe pas
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    await userRef.set({
      userId,
      username,
      points: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  bot.sendMessage(userId, `👋 Bienvenue ${username} !\n\nGagne des points en regardant des pubs et dépense-les dans la boutique pour débloquer des contenus exclusifs.`, {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '🚀 Ouvrir la boutique',
          web_app: { url: MINI_APP_URL }
        }
      ]]
    }
  });
});

// ─────────────────────────────────────────────
// COMMANDE /points
// ─────────────────────────────────────────────
bot.onText(/\/points/, async (msg) => {
  const userId = msg.from.id;
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return bot.sendMessage(userId, '❌ Tu n\'es pas encore inscrit. Tape /start pour commencer.');
  }

  const points = userDoc.data().points || 0;
  bot.sendMessage(userId, `💰 Tu as actuellement *${points} points*.`, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
// COMMANDE /addcontent (ADMIN)
// ─────────────────────────────────────────────
bot.onText(/\/addcontent/, async (msg) => {
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) {
    return bot.sendMessage(userId, '❌ Commande réservée à l\'admin.');
  }

  bot.sendMessage(userId, '📸 Envoie-moi la photo ou vidéo à ajouter au catalogue.');

  // Écoute le prochain message de l'admin
  bot.once('message', async (mediaMsg) => {
    if (mediaMsg.from.id !== ADMIN_ID) return;

    let fileId = null;
    let type = null;

    if (mediaMsg.photo) {
      fileId = mediaMsg.photo[mediaMsg.photo.length - 1].file_id;
      type = 'photo';
    } else if (mediaMsg.video) {
      fileId = mediaMsg.video.file_id;
      type = 'video';
    } else {
      return bot.sendMessage(ADMIN_ID, '❌ Envoie uniquement une photo ou une vidéo.');
    }

    bot.sendMessage(ADMIN_ID, '✏️ Donne un titre et un prix séparés par une virgule.\nEx: Photo plage, 50');

    bot.once('message', async (infoMsg) => {
      if (infoMsg.from.id !== ADMIN_ID) return;

      const parts = infoMsg.text.split(',');
      if (parts.length < 2) {
        return bot.sendMessage(ADMIN_ID, '❌ Format incorrect. Ex: Photo plage, 50');
      }

      const title = parts[0].trim();
      const price = parseInt(parts[1].trim());

      if (isNaN(price)) {
        return bot.sendMessage(ADMIN_ID, '❌ Le prix doit être un nombre.');
      }

      await db.collection('content').add({
        title,
        price,
        fileId,
        type,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      bot.sendMessage(ADMIN_ID, `✅ Contenu ajouté !\n📌 Titre: ${title}\n💰 Prix: ${price} points\n📁 Type: ${type}`);
    });
  });
});

// ─────────────────────────────────────────────
// COMMANDE /stats (ADMIN)
// ─────────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id;
  if (userId !== ADMIN_ID) return;

  const usersSnap = await db.collection('users').get();
  const contentSnap = await db.collection('content').get();
  const purchasesSnap = await db.collection('purchases').get();

  let totalPoints = 0;
  usersSnap.forEach(doc => { totalPoints += doc.data().points || 0; });

  bot.sendMessage(ADMIN_ID,
    `📊 *Statistiques*\n\n` +
    `👥 Utilisateurs: ${usersSnap.size}\n` +
    `🖼️ Contenus en boutique: ${contentSnap.size}\n` +
    `🛍️ Achats effectués: ${purchasesSnap.size}\n` +
    `💰 Points en circulation: ${totalPoints}`,
    { parse_mode: 'Markdown' }
  );
});

// ─────────────────────────────────────────────
// WEBHOOK depuis la Mini App
// ─────────────────────────────────────────────
const express = require('express');
const app = express();
app.use(express.json());

// Créditer des points après pub
app.post('/reward', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId manquant' });

  const userRef = db.collection('users').doc(String(userId));
  await userRef.update({
    points: admin.firestore.FieldValue.increment(POINTS_PAR_PUB)
  });

  const userDoc = await userRef.get();
  const newPoints = userDoc.data().points;

  bot.sendMessage(userId, `🎉 Tu as gagné *${POINTS_PAR_PUB} points* en regardant la pub !\n💰 Total: *${newPoints} points*`, { parse_mode: 'Markdown' });

  res.json({ success: true, points: newPoints });
});

// Récupérer les infos utilisateur
app.get('/user/:userId', async (req, res) => {
  const userRef = db.collection('users').doc(req.params.userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(userDoc.data());
});

// Récupérer le catalogue
app.get('/catalogue', async (req, res) => {
  const snap = await db.collection('content').orderBy('createdAt', 'desc').get();
  const items = [];
  snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
  res.json(items);
});

// Acheter un contenu
app.post('/buy', async (req, res) => {
  const { userId, contentId } = req.body;
  if (!userId || !contentId) return res.status(400).json({ error: 'Paramètres manquants' });

  // Vérifier si déjà acheté
  const purchaseRef = db.collection('purchases').doc(`${userId}_${contentId}`);
  const purchaseDoc = await purchaseRef.get();

  if (purchaseDoc.exists) {
    return res.status(400).json({ error: 'Déjà acheté' });
  }

  // Récupérer le contenu
  const contentRef = db.collection('content').doc(contentId);
  const contentDoc = await contentRef.get();
  if (!contentDoc.exists) return res.status(404).json({ error: 'Contenu introuvable' });

  const content = contentDoc.data();

  // Vérifier les points
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();
  if (!userDoc.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const userPoints = userDoc.data().points || 0;
  if (userPoints < content.price) {
    return res.status(400).json({ error: 'Points insuffisants' });
  }

  // Débiter les points
  await userRef.update({
    points: admin.firestore.FieldValue.increment(-content.price)
  });

  // Enregistrer l'achat
  await purchaseRef.set({
    userId,
    contentId,
    title: content.title,
    purchasedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Envoyer le contenu en message privé
  if (content.type === 'photo') {
    await bot.sendPhoto(userId, content.fileId, { caption: `✅ Tu as débloqué : *${content.title}*`, parse_mode: 'Markdown' });
  } else if (content.type === 'video') {
    await bot.sendVideo(userId, content.fileId, { caption: `✅ Tu as débloqué : *${content.title}*`, parse_mode: 'Markdown' });
  }

  const updatedUser = await userRef.get();
  res.json({ success: true, points: updatedUser.data().points });
});

// Récupérer les achats d'un user
app.get('/purchases/:userId', async (req, res) => {
  const snap = await db.collection('purchases')
    .where('userId', '==', req.params.userId)
    .get();

  const purchases = [];
  snap.forEach(doc => purchases.push({ id: doc.id, ...doc.data() }));
  res.json(purchases);
});

app.listen(3000, () => console.log('✅ Serveur démarré sur le port 3000'));
console.log('🤖 Bot démarré...');
