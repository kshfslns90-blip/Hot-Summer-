// Outgoing email - the reset and invitation links - over the SMTP account in the project's
// settings, its password a secret. Without an account nothing is sent: the link is logged and
// handed back to the caller, which is how a development machine works and how the tests read it.
import nodemailer from 'nodemailer';

export function isConfigured(mail) {
  return Boolean(mail && mail.host && mail.from);
}

// The account's password is a secret the settings name (mail.passwordSecret), opened here, at
// the moment of sending; an account without a user name signs in with none.
export async function authOf(mail) {
  if (!mail.user) return undefined;
  const { readSecret } = await import('./secrets.js');
  try {
    return { user: mail.user, pass: readSecret(mail.passwordSecret) };
  } catch (err) {
    const e = new Error(`The mail password could not be read: ${err.message}`);
    e.status = 400;
    throw e;
  }
}

async function transport(mail) {
  return nodemailer.createTransport({
    host: mail.host,
    port: Number(mail.port) || 587,
    secure: Boolean(mail.secure),
    auth: await authOf(mail)
  });
}

// { to, subject, text, html?, link? } -> { delivered, link? }
export async function send(message, mail) {
  if (!isConfigured(mail)) {
    console.log(`[mail] not configured - "${message.subject}" for ${message.to}${message.link ? `: ${message.link}` : ''}`);
    return { delivered: false, link: message.link || null };
  }
  await (await transport(mail)).sendMail({ from: mail.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  return { delivered: true };
}

export async function sendTest(to, mail, projectName) {
  if (!isConfigured(mail)) {
    const err = new Error('Fill in the mail host and the from address, save, and try again.');
    err.status = 400;
    throw err;
  }
  await send({ to, subject: `${projectName}: test email`, text: `This is a test email from ${projectName}. Your mail settings work.` }, mail);
  return { delivered: true };
}

export function resetMessage({ to, link, projectName }) {
  return {
    to,
    link,
    subject: `${projectName}: reset your password`,
    text: `Someone - hopefully you - asked to reset the password for ${to} at ${projectName}.\n\nOpen this link to choose a new password (it works for one hour):\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
    html: `<p>Someone - hopefully you - asked to reset the password for <b>${to}</b> at ${projectName}.</p><p><a href="${link}">Choose a new password</a> (the link works for one hour).</p><p>If you did not ask for this, you can ignore this email.</p>`
  };
}

export function inviteMessage({ to, link, projectName, invitedBy }) {
  const by = invitedBy ? ` by ${invitedBy}` : '';
  return {
    to,
    link,
    subject: `${projectName}: you are invited`,
    text: `You have been invited${by} to ${projectName}.\n\nOpen this link to choose your password and sign in (it works for seven days):\n${link}`,
    html: `<p>You have been invited${by} to <b>${projectName}</b>.</p><p><a href="${link}">Choose your password and sign in</a> (the link works for seven days).</p>`
  };
}
