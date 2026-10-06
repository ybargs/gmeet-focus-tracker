import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAL9NhthsEicdZogXISL1SyEezKKaOWKaM",
  authDomain: "gmeet-focus-tracker.firebaseapp.com",
  projectId: "gmeet-focus-tracker",
  storageBucket: "gmeet-focus-tracker.firebasestorage.app",
  messagingSenderId: "596698279952",
  appId: "1:596698279952:web:7ffe0c5dd7031419f1da95",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
