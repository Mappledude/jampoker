// Load Firebase for plain browser pages (no build tools needed)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";

const firebaseConfig = {
  apiKey: "AIzaSyA2xi-TpIZYXJP8WIeLuSojgNHmUJMe0vc",
  authDomain: "jam-poker.firebaseapp.com",
  projectId: "jam-poker",
  storageBucket: "jam-poker.firebasestorage.app",
  messagingSenderId: "1026182214332",
  appId: "1:1026182214332:web:0e8122bf7da47e48a896b9"
};

// Initialize Firebase and export for other scripts (later)
export const app = initializeApp(firebaseConfig);

// Tiny visual check: write the projectId onto the home page if there's an element with id="fb-status"
window.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("fb-status");
  if (el) el.textContent = `Firebase connected to ${app.options.projectId}`;
});
