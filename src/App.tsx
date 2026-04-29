import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Image as ImageIcon, 
  Sparkles, 
  Download, 
  History, 
  Layout, 
  Trash2,
  Loader2,
  Settings,
  User as UserIcon,
  Plus,
  Pencil,
  Upload,
  Check,
  Menu,
  X,
  AlertCircle,
  MapPin,
  LogOut,
  LogIn
} from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { generateImage } from "./services/gemini";
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  deleteDoc, 
  query, 
  orderBy, 
  onSnapshot,
  where,
  limit,
  serverTimestamp
} from "firebase/firestore";
import { onAuthStateChanged, User } from "firebase/auth";
import { db, auth, signInWithGoogle, loginAnonymously } from "./lib/firebase";
import { handleFirestoreError, OperationType } from "./lib/firebase-utils";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  timestamp: any;
  userId: string;
}

interface UserTemplate {
  id: string;
  name: string;
  prompt: string;
  thumbnail: string | null;
  reference_image: string | null;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: string;
}

function SectionHeader({ icon: Icon, title, subtitle, color = "indigo" }: { icon: any, title: string, subtitle: string, color?: string }) {
  const bgClass = color === "indigo" ? "bg-[#6366F1]" : "bg-[#6366F1]"; // Keeping consistent with user's indigo/purple request
  return (
    <div className={cn(bgClass, "p-5 rounded-t-[2.5rem] text-white space-y-1.5 shadow-sm")}>
      <div className="flex items-center gap-3">
        <div className="p-2 bg-white/20 rounded-xl backdrop-blur-sm">
          <Icon size={20} className="text-white" />
        </div>
        <h2 className="text-lg font-bold tracking-wide">{title}</h2>
      </div>
      <p className="text-[11px] text-white/70 font-medium pl-1">{subtitle}</p>
    </div>
  );
}


const compressImage = async (base64Str: string, maxBytes = 800000): Promise<string> => {
  if (base64Str.length < maxBytes) return base64Str;
  
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = base64Str;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;
      
      const MAX_W = 500;
      const MAX_H = 750;
      if (width > MAX_W || height > MAX_H) {
         const scale = Math.min(MAX_W/width, MAX_H/height);
         width = width * scale;
         height = height * scale;
      }
      
      canvas.width = Math.floor(width);
      canvas.height = Math.floor(height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64Str);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      let quality = 0.8;
      let compressedStr = canvas.toDataURL("image/jpeg", quality);
      
      while (compressedStr.length > maxBytes && quality > 0.1) {
        quality -= 0.15;
        compressedStr = canvas.toDataURL("image/jpeg", quality);
      }
      
      resolve(compressedStr);
    };
    img.onerror = () => resolve(base64Str);
  });
};

export default function App() {
  const [activeTab, setActiveTab] = useState<"user" | "admin" | "map-qr">("user");
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [checkingApiKey, setCheckingApiKey] = useState(true);

  useEffect(() => {
    const checkKey = async () => {
      // If we have a hardcoded key from build time that isn't the placeholder, 
      // we're good (this happens in deployed apps)
      const buildTimeKey = process.env.GEMINI_API_KEY;
      if (buildTimeKey && buildTimeKey !== "MY_GEMINI_API_KEY" && buildTimeKey !== "") {
        setCheckingApiKey(false);
        return;
      }

      if (localStorage.getItem('skip_api_key_prompt')) {
        setCheckingApiKey(false);
        return;
      }

      // In AI Studio Preview, use the bridge to check if a secret is selected
      if (typeof window !== 'undefined' && 'aistudio' in window) {
        try {
          const hasKey = await (window as any).aistudio.hasSelectedApiKey();
          if (!hasKey) {
            setNeedsApiKey(true);
          }
        } catch (e) {
          console.error("Failed to check API key", e);
        }
      }
      setCheckingApiKey(false);
    };
    checkKey();
  }, []);

  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [mapUrl, setMapUrl] = useState("");
  const [qrColor, setQrColor] = useState("#6366F1");
  const [includeLogo, setIncludeLogo] = useState(true);
  const [qrFrame, setQrFrame] = useState(true);
  const [customPrompt, setCustomPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedResult, setGeneratedResult] = useState<string | null>(null);
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userRole, setUserRole] = useState<"admin" | "user">("user");
  const [allUsers, setAllUsers] = useState<any[]>([]);
  
  // Template Management State
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplatePrompt, setNewTemplatePrompt] = useState("");
  const [newTemplateThumbnail, setNewTemplateThumbnail] = useState<string | null>(null);
  const [newTemplateReferenceImage, setNewTemplateReferenceImage] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  
  // Custom logo per color
  const [qrLogoDataUrl, setQrLogoDataUrl] = useState<string>("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        if (!user.isAnonymous && user.email) {
          const userRef = doc(db, "users", user.uid);
          try {
             const userSnap = await getDoc(userRef);
             if (!userSnap.exists()) {
               const role = user.email.toLowerCase() === "henrythonny@gmail.com".toLowerCase() ? "admin" : "user";
               await setDoc(userRef, {
                 uid: user.uid,
                 email: user.email,
                 role: role,
                 createdAt: serverTimestamp()
               });
               setUserRole(role);
             } else {
               setUserRole(userSnap.data().role || "user");
             }
          } catch (e) {
             console.error("Error creating/fetching user profile", e);
             if (user.email.toLowerCase() === "henrythonny@gmail.com".toLowerCase()) {
               setUserRole("admin");
             }
          }
        }
      } else {
        setUserRole("user");
        setCurrentUser(null);
        // Automatically sign in anonymously if not logged in
        loginAnonymously().catch(console.error);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Create an SVG for the MapPin with the current qrColor
    const svgString = `
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="white" stroke="${qrColor.replace('#', '%23')}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3"/>
      </svg>
    `.trim();
    
    // We fill with white but stroke with the theme color to make it pop on both light and dark QR codes
    // Or we could just make it solid qrColor. User asked "can change color".
    // Let's make it solid qrColor.
    const themedSvgString = `
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="${qrColor.replace('#', '%23')}" stroke="none">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
        <circle cx="12" cy="10" r="3" fill="white"/>
      </svg>
    `.trim();

    setQrLogoDataUrl(`data:image/svg+xml;utf8,${themedSvgString}`);
  }, [qrColor]);
  
  // Appearance State
  const [bgColor, setBgColor] = useState("blue");
  const [isNanoBananaPro, setIsNanoBananaPro] = useState(false);
  const [clarityLevel, setClarityLevel] = useState<"standard" | "ultra">("ultra");
  const [showCustomPromptArea, setShowCustomPromptArea] = useState(true);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [localApiKey, setLocalApiKey] = useState(localStorage.getItem('gemini_api_key') || "");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);

  const isAdmin = () => {
    return userRole === "admin" || (currentUser?.email?.toLowerCase() === "henrythonny@gmail.com");
  };
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [errorModal, setErrorModal] = useState<{show: boolean, type: string, message?: string} | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const templateThumbRef = useRef<HTMLInputElement>(null);
  const referenceImgRef = useRef<HTMLInputElement>(null);

  const BASE_CV_PROMPT = "Professional 4x6 passport photo, high-quality studio portrait, solid blue background, formal attire, sharp focus, symmetrical composition, professional lighting, cinematic quality.";

  useEffect(() => {
    if (currentUser) {
      const unsubTemplates = onSnapshot(collection(db, "templates"), (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as UserTemplate));
        // Sort on client to handle missing updatedAt/createdAt fields gracefully
        const sortedData = data.sort((a, b) => {
          const timeA = a.updatedAt || a.createdAt || 0;
          const timeB = b.updatedAt || b.createdAt || 0;
          return timeB - timeA;
        });
        setUserTemplates(sortedData);
      }, (error) => handleFirestoreError(error, OperationType.GET, "templates"));

      const unsubHistory = onSnapshot(query(collection(db, "history"), where("userId", "==", currentUser.uid)), (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as GeneratedImage));
        const sortedData = data.sort((a, b) => {
          const getTime = (ts: any) => {
            if (!ts) return 0;
            if (typeof ts === 'number') return ts;
            if (ts.toMillis) return ts.toMillis();
            if (ts.seconds) return ts.seconds * 1000;
            return 0;
          };
          return getTime(b.timestamp) - getTime(a.timestamp);
        });
        setHistory(sortedData.slice(0, 20));
      }, (error) => handleFirestoreError(error, OperationType.GET, "history"));

      const unsubSettings = onSnapshot(doc(db, "settings", "global"), (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          if (data.showCustomPromptArea !== undefined) setShowCustomPromptArea(data.showCustomPromptArea);
        }
      }, (error) => handleFirestoreError(error, OperationType.GET, "settings/global"));

      let unsubUsers: any = null;
      if (isAdmin()) {
        unsubUsers = onSnapshot(collection(db, "users"), (snapshot) => {
          setAllUsers(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => handleFirestoreError(error, OperationType.GET, "users"));
      }

      return () => {
        unsubTemplates();
        unsubHistory();
        unsubSettings();
        if (unsubUsers) unsubUsers();
      };
    } else {
      setUserTemplates([]);
      setHistory([]);
      setAllUsers([]);
    }
  }, [currentUser, userRole]);

  const updateSetting = async (key: string, value: any) => {
    try {
      await setDoc(doc(db, "settings", "global"), { [key]: value }, { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, "settings/global");
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const compressImage = (dataUrl: string, maxWidth = 800, maxHeight = 800): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxWidth) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            }
          } else {
            if (height > maxHeight) {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx?.drawImage(img, 0, 0, width, height);
          const result = canvas.toDataURL("image/jpeg", 0.7);
          console.log("Compressed image size:", result.length);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Failed to load image for compression"));
      img.src = dataUrl;
    });
  };

  const handleThumbnailUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          setSaveStatus("កំពុងបង្ហាប់រូបភាព... (Compressing image...)");
          const compressed = await compressImage(reader.result as string);
          setNewTemplateThumbnail(compressed);
          setSaveStatus(null);
        } catch (err) {
          console.error("Compression error:", err);
          alert("បរាជ័យក្នុងការបង្ហាប់រូបភាព (Failed to compress image)");
          setSaveStatus(null);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleReferenceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          setSaveStatus("កំពុងបង្ហាប់រូបភាព... (Compressing image...)");
          const compressed = await compressImage(reader.result as string);
          setNewTemplateReferenceImage(compressed);
          setSaveStatus(null);
        } catch (err) {
          console.error("Compression error:", err);
          alert("បរាជ័យក្នុងការបង្ហាប់រូបភាព (Failed to compress image)");
          setSaveStatus(null);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  
  useEffect(() => {
    if (currentUser) {
      console.log("Current user:", currentUser.email, "UID:", currentUser.uid);
    }
  }, [currentUser]);

  const saveTemplate = async () => {
    if (!newTemplateName || !newTemplatePrompt) {
      alert("សូមបញ្ចូលឈ្មោះ និង Prompt (Please enter name and prompt)");
      return;
    }
    
    if (!currentUser) {
      alert("សូមចូលប្រើប្រាស់ដើម្បីរក្សាទុកគម្រូ (Please sign in to save template)");
      return;
    }

    setIsSavingTemplate(true);
    setSaveStatus("កំពុងពិនិត្យទំហំរូបភាព... (Checking image size...)");
    
    // Check total document size (Firestore limit is 1MB)
    const totalImageSize = (newTemplateThumbnail?.length || 0) + (newTemplateReferenceImage?.length || 0);
    if (totalImageSize > 850000) { 
      alert("ទំហំរូបភាពសរុបធំពេក (Total image size too large). Please select smaller images.");
      setIsSavingTemplate(false);
      setSaveStatus(null);
      return;
    }

    setSaveStatus("កំពុងរៀបចំទិន្នន័យ... (Preparing data...)");
    const id = editingTemplateId || Date.now().toString();
    const wasEditing = !!editingTemplateId;
    const templateData = {
      name: newTemplateName,
      prompt: newTemplatePrompt,
      thumbnail: newTemplateThumbnail,
      reference_image: newTemplateReferenceImage,
      updatedAt: serverTimestamp(),
      ...(editingTemplateId ? {} : { createdAt: serverTimestamp(), createdBy: currentUser.uid })
    };
    
    setSaveStatus("កំពុងរក្សាទុកទៅ Database... (Saving to database...)");
    try {
      console.log("Saving template doc ID:", id);
      await setDoc(doc(db, "templates", id), templateData, { merge: true });
      
      setSaveStatus("ជោគជ័យ! (Success!)");
      setNewTemplateName("");
      setNewTemplatePrompt("");
      setNewTemplateThumbnail(null);
      setNewTemplateReferenceImage(null);
      setEditingTemplateId(null);
      
      alert(wasEditing ? "កែប្រែគម្រូជោគជ័យ! (Template updated!)" : "រក្សាទុកគម្រូថ្មីជោគជ័យ! (New template saved!)");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (e: any) {
      console.error("Save template error:", e);
      setSaveStatus(`បរាជ័យ (Failed): ${e.message || "Unknown error"}`);
      handleFirestoreError(e, OperationType.WRITE, `templates/${id}`);
    } finally {
      setIsSavingTemplate(false);
    }
  };

  const deleteTemplate = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    console.log("Attempting to delete template:", id);
    
    // Use custom state for confirmation instead of window.confirm
    if (deletingTemplateId === id) {
      setDeletingTemplateId(null); // Cancel
      return;
    }

    setDeletingTemplateId(id);
  };

  const confirmDeleteTemplate = async (id: string) => {
    console.log("Confirming deletion for template ID:", id);
    if (!currentUser) {
      console.error("No user signed in during deletion attempt");
      setSaveStatus("កំហុស៖ មិនមានអ្នកប្រើប្រាស់បានចូល (Error: No user signed in)");
      return;
    }
    console.log("User UID:", currentUser.uid);
    setSaveStatus("កំពុងលុប... (Deleting...)");
    try {
      await deleteDoc(doc(db, "templates", id));
      console.log("Deletion successful for ID:", id);
      setSaveStatus("លុបបានជោគជ័យ! (Deleted successfully!)");
      setTimeout(() => setSaveStatus(null), 3000);
      setDeletingTemplateId(null);
    } catch (e: any) {
      console.error("Delete template firestore error:", e);
      setSaveStatus(`បរាជ័យ (Failed): ${e.message || "Unknown error"}`);
      handleFirestoreError(e, OperationType.DELETE, `templates/${id}`);
    }
  };

  const updateUserRole = async (userId: string, newRole: "admin" | "user") => {
    try {
      await setDoc(doc(db, "users", userId), { role: newRole }, { merge: true });
      alert(`User role updated to ${newRole}`);
    } catch (e: any) {
      console.error("Error updating user role:", e);
      alert("Failed to update user role");
      handleFirestoreError(e, OperationType.WRITE, `users/${userId}`);
    }
  };

  const startEditing = (template: UserTemplate) => {
    setEditingTemplateId(template.id);
    setNewTemplateName(template.name);
    setNewTemplatePrompt(template.prompt);
    setNewTemplateThumbnail(template.thumbnail);
    setNewTemplateReferenceImage(template.reference_image);
  };

  const deleteHistoryItem = async (id: string) => {
    try {
      await deleteDoc(doc(db, "history", id));
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `history/${id}`);
    }
  };

  const clearAllHistory = async () => {
    if (!confirm("តើអ្នកប្រាកដថាចង់លុបប្រវត្តិទាំងអស់មែនទេ?")) return;
    try {
      // In a real app we'd batch delete, but for simplicity:
      for (const item of history) {
        await deleteDoc(doc(db, "history", item.id));
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, "history");
    }
  };
  const downloadFile = async (url: string, filename: string) => {
    try {
      // For data URLs, we can just use them directly, but for external URLs we need to fetch
      if (url.startsWith('data:')) {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }

      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
    } catch (error) {
      console.error("Download failed", error);
      // Fallback
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleGenerate = async () => {
    if (!uploadedImage || isGenerating) return;

    setIsGenerating(true);
    setGeneratedResult(null);
    try {
      const colorPrompt = bgColor === "blue" ? "solid blue background" : bgColor === "red" ? "solid red background" : "solid white background";
      
      let enhancementPrompt = "";
      if (isNanoBananaPro) {
        enhancementPrompt += "Nano Banana Pro Cinema quality, hyper-realistic, studio lighting, 3D depth, professional contrast, masterpiece details. ";
      }
      if (clarityLevel === "ultra") {
        enhancementPrompt += "Ultra-sharp focus, 8k resolution, highly detailed skin texture, professional lens quality, no blur. ";
      }

      let finalPrompt = customPrompt 
        ? `${BASE_CV_PROMPT}. Specific instruction: ${customPrompt}. Use ${colorPrompt}. ${enhancementPrompt}` 
        : `${BASE_CV_PROMPT} Use ${colorPrompt}. ${enhancementPrompt}`;

      const inputImages = [uploadedImage];
      
      // If a template is selected, add its reference image if it exists
      if (selectedTemplateId) {
        const selectedTemplate = userTemplates.find(t => t.id === selectedTemplateId);
        if (selectedTemplate?.reference_image) {
          inputImages.push(selectedTemplate.reference_image);
          finalPrompt += `. Follow the style, clothing, and details of the provided reference image strictly.`;
        }
      }
        
      const finalPromptToUse = `${finalPrompt}, highly detailed, photorealistic, 8k resolution, professional cinematic lighting, sharp focus, masterpiece quality.`;

      const resultUrl = await generateImage(finalPromptToUse, "3:4", inputImages);
      setGeneratedResult(resultUrl);
      
      if (currentUser) {
        const id = Date.now().toString();
        
        let historyUrl = resultUrl;
        try {
          historyUrl = await compressImage(resultUrl, 800000);
        } catch (err) {
          console.warn("Failed to compress image for history", err);
        }
        
        const newImage = {
          url: historyUrl,
          prompt: finalPrompt,
          timestamp: serverTimestamp(),
          userId: currentUser.uid
        };
        
        try {
          console.log("Saving to history, size:", historyUrl.length);
          await setDoc(doc(db, "history", id), newImage);
          console.log("History saved successfully");
        } catch (e: any) {
          console.error("History save failed:", e);
          // If it still fails due to size, try extreme compression
          if (e.message?.includes("too large")) {
             try {
                const tinyUrl = await compressImage(resultUrl, 300000);
                await setDoc(doc(db, "history", id), { ...newImage, url: tinyUrl });
             } catch (innerErr) {
                console.error("Extreme compression also failed", innerErr);
             }
          }
          handleFirestoreError(e, OperationType.WRITE, `history/${id}`);
        }
      }
    } catch (error: any) {
      console.error("Generation failed", error);
      if (error.message?.includes("QUOTA_EXCEEDED") || error.message?.includes("429")) {
        setErrorModal({ show: true, type: "quota", message: error.message });
      } else {
        alert("ការបង្កើតរូបភាពបានបរាជ័យ៖ " + error.message);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  if (checkingApiKey) {
    return (
      <div className="min-h-screen bg-[#F3F4F6] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (needsApiKey) {
    return (
      <div className="min-h-screen bg-[#F3F4F6] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 text-center flex flex-col items-center">
          <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto text-indigo-600 mb-6 relative">
            <Settings size={32} />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-3">របៀបប្រើប្រាស់ដោយឥតគិតថ្លៃ (Free)</h2>
          <p className="text-gray-600 text-sm leading-relaxed mb-6">
            កម្មវិធីនេះមានកូតាឥតគិតថ្លៃ (Free Quota) កំណត់ប្រចាំថ្ងៃ។ ប្រសិនបើកូតាពីប្រព័ន្ធអស់ លោកអ្នកអាចប្រើប្រាស់វាដោយឥតគិតថ្លៃ ១០០% ដោយប្រើ <strong>Gemini API Key</strong> ផ្ទាល់ខ្លួនបាន។
          </p>
          <div className="w-full space-y-3 pt-2 text-left bg-indigo-50 p-4 rounded-2xl mb-6">
             <h3 className="text-sm font-bold text-indigo-900">ដើម្បីទទួលបាន API Key ឥតគិតថ្លៃ៖</h3>
             <ol className="list-decimal pl-5 text-sm text-indigo-800 space-y-1">
               <li>ចូលទៅកាន់ <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline font-semibold hover:text-indigo-600">aistudio.google.com/app/apikey</a></li>
               <li>ចុចប៊ូតុង "Create API key"</li>
               <li>យក Key នោះមកជ្រើសរើសនៅទីនេះ ឬដាក់ក្នុង Settings</li>
             </ol>
          </div>
          <div className="w-full space-y-4">
            {(typeof window !== 'undefined' && 'aistudio' in window) && (
              <button
                onClick={async () => {
                  try {
                    await (window as any).aistudio.openSelectKey();
                    setNeedsApiKey(false); // Assume successful
                    localStorage.setItem('skip_api_key_prompt', 'true');
                  } catch (e) {
                    console.error(e);
                    setNeedsApiKey(false); // Fallback
                    localStorage.setItem('skip_api_key_prompt', 'true');
                  }
                }}
                className="w-full py-3.5 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"
              >
                ជ្រើសរើស API Key ស្វ័យប្រវត្តិ
              </button>
            )}
            
            <div className="space-y-2 text-left">
              <label className="text-sm font-bold text-gray-700 select-none">បញ្ចូល API Key ឥតគិតថ្លៃ (Free API Key)</label>
              <input 
                type="password"
                value={localApiKey}
                onChange={(e) => {
                  setLocalApiKey(e.target.value);
                  if (e.target.value.trim()) {
                    localStorage.setItem('gemini_api_key', e.target.value.trim());
                  } else {
                    localStorage.removeItem('gemini_api_key');
                  }
                }}
                placeholder="AIzaSy..."
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-600/20 transition-all font-mono"
              />
            </div>

            <button
              onClick={() => {
                localStorage.setItem('skip_api_key_prompt', 'true');
                setNeedsApiKey(false);
              }}
              className="w-full py-3.5 bg-white border-2 border-gray-200 text-gray-600 rounded-xl font-bold hover:bg-gray-50 transition-colors mt-2"
            >
              បន្តទៅមុខ (Continue)
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F3F4F6] text-[#374151] font-sans pt-20">
      {/* Navigation Bar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-100 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#6366F1] rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
              <Sparkles size={20} />
            </div>
            <div>
              <h1 className="text-lg font-black text-gray-900 tracking-tight leading-none uppercase">PONLEU-AI</h1>
              <p className="text-[10px] text-gray-400 font-bold tracking-widest uppercase mt-0.5">Professional AI</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {currentUser && !currentUser.isAnonymous && (
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-xl border border-gray-100">
                <img src={currentUser.photoURL || ""} alt="" className="w-6 h-6 rounded-full" />
                <span className="text-xs font-bold text-gray-700">{currentUser.displayName}</span>
              </div>
            )}
            <div className="relative">
              <button 
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="p-2.5 bg-gray-50 hover:bg-gray-100 rounded-xl transition-all text-gray-600 border border-gray-100"
              >
                {isMenuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>

              <AnimatePresence>
                {isMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute right-0 mt-3 w-56 bg-white rounded-3xl shadow-2xl border border-gray-100 p-2 z-[60]"
                  >
                    <div className="p-3 mb-2 border-b border-gray-50">
                      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-2">Navigation</p>
                    </div>
                    
                    <button
                      onClick={() => {
                        setActiveTab("user");
                        setIsMenuOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-bold transition-all text-sm",
                        activeTab === "user" ? "bg-[#6366F1] text-white shadow-lg shadow-indigo-500/20" : "text-gray-500 hover:bg-gray-50"
                      )}
                    >
                      <UserIcon size={18} />
                      Photo AI
                    </button>
                    
                    {/* ... (existing menu items) ... */}
                    <button
                      onClick={() => {
                        setActiveTab("map-qr");
                        setIsMenuOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-bold transition-all text-sm mt-1",
                        activeTab === "map-qr" ? "bg-[#6366F1] text-white shadow-lg shadow-indigo-500/20" : "text-gray-500 hover:bg-gray-50"
                      )}
                    >
                      <MapPin size={18} />
                      Map QR Code
                    </button>

                    {isAdmin() && (
                      <button
                        onClick={() => {
                          setActiveTab("admin");
                          setIsMenuOpen(false);
                        }}
                        className={cn(
                          "w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-bold transition-all text-sm mt-1",
                          activeTab === "admin" ? "bg-[#6366F1] text-white shadow-lg shadow-indigo-500/20" : "text-gray-500 hover:bg-gray-50"
                        )}
                      >
                        <Settings size={18} />
                        Setting
                      </button>
                    )}

                    <div className="my-2 border-t border-gray-50 pt-2">
                      <button
                        onClick={() => {
                          setShowSettingsModal(true);
                          setIsMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-bold transition-all text-sm text-gray-500 hover:bg-gray-50"
                      >
                        <Settings size={18} />
                        API
                      </button>
                      
                      {loginError && (
                        <div className="px-4 py-2 mb-2 bg-red-50 text-red-600 text-[10px] rounded-xl flex items-center gap-2">
                          <AlertCircle size={12} />
                          <span>{loginError}</span>
                        </div>
                      )}
                      {currentUser && !currentUser.isAnonymous ? (
                        <button
                          onClick={() => {
                            auth.signOut();
                            setIsMenuOpen(false);
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-bold transition-all text-sm text-red-500 hover:bg-red-50"
                        >
                          <LogOut size={18} />
                          ចាកចេញ (Sign Out)
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            try {
                              setLoginError(null);
                              await signInWithGoogle();
                              setIsMenuOpen(false);
                            } catch (e: any) {
                              console.error(e);
                              setLoginError(e.message || "Login failed. Please check browser pop-up settings.");
                            }
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl font-bold transition-all text-sm text-indigo-600 hover:bg-indigo-50"
                        >
                          <LogIn size={18} />
                          ចូលប្រើ (Sign In)
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </nav>

      {/* Backdrop for click away */}
      {isMenuOpen && (
        <div 
          className="fixed inset-0 z-40" 
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      {/* Error Modals */}
      <AnimatePresence>
        {errorModal?.show && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] w-full max-w-md overflow-hidden shadow-2xl"
            >
              <div className="bg-red-500 p-8 text-white text-center space-y-3">
                <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto backdrop-blur-md">
                  <AlertCircle size={32} />
                </div>
                <h3 className="text-xl font-bold">អស់កូតាប្រើប្រាស់ (Quota Exceeded)</h3>
              </div>
              <div className="p-8 space-y-6">
                <p className="text-gray-600 text-sm leading-relaxed text-center">
                  អ្នកបានប្រើប្រាស់អស់កូតាឥតគិតថ្លៃសម្រាប់ពេលនេះហើយ។ សូមជ្រើសរើស ឬបញ្ចូល API Key ដើម្បីបន្តប្រើប្រាស់។
                </p>
                {/* AI Studio specific API key selection flow */}
                <div className="space-y-4">
                  {(typeof window !== 'undefined' && 'aistudio' in window) && (
                    <button 
                      onClick={async () => {
                        try {
                          await (window as any).aistudio.openSelectKey();
                          setErrorModal(null);
                        } catch (err) {
                          console.error("Failed to open select key dialog", err);
                        }
                      }}
                      className="w-full py-3 bg-[#6366F1] text-white rounded-xl font-bold hover:bg-indigo-600 transition-all text-sm"
                    >
                      ជ្រើសរើស API Key ស្វ័យប្រវត្តិ
                    </button>
                  )}
                  
                  <div className="space-y-2 text-left">
                    <label className="text-sm font-bold text-gray-700">បញ្ចូល API Key ឥតគិតថ្លៃ</label>
                    <input 
                      type="password"
                      value={localApiKey}
                      onChange={(e) => {
                        setLocalApiKey(e.target.value);
                        if (e.target.value.trim()) {
                          localStorage.setItem('gemini_api_key', e.target.value.trim());
                        } else {
                          localStorage.removeItem('gemini_api_key');
                        }
                      }}
                      placeholder="AIzaSy..."
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-600/20 transition-all font-mono"
                    />
                    <div className="text-[10px] text-indigo-600 pt-1">
                       <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline font-semibold hover:text-indigo-800">យក API Key ឥតគិតថ្លៃទីនេះ</a>
                    </div>
                  </div>
                </div>
                {errorModal?.message && (
                  <div className="p-3 bg-red-50 rounded-xl border border-red-100 text-red-600 text-[10px] break-all">
                    Detail: {errorModal.message}
                  </div>
                )}
                <div className="space-y-4">
                  <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 flex gap-4">
                    <div className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Settings size={16} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-bold text-gray-800">របៀបទទួលបានកូតាធំ (How to get larger quota)</p>
                      <p className="text-[10px] text-gray-500 leading-relaxed">
                        ចូលទៅកន្លែង Settings នៃ AI Studio ដើម្បីជ្រើសរើស Google Cloud API Key ។
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setErrorModal(null)}
                    className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold hover:bg-black transition-all active:scale-95"
                  >
                    យល់ព្រម
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {activeTab === "user" && (
        <motion.div 
          key="user-tab"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="max-w-7xl mx-auto px-6 pb-20"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column: UI Controls & Templates */}
            <div className="space-y-8">
              <div className="bg-white rounded-[2.5rem] shadow-sm border border-gray-100 overflow-hidden">
                <SectionHeader 
                  icon={Sparkles}
                  title="ជ្រើសរើសគម្រូ និងកំណត់រចនាប័ទ្ម"
                  subtitle="Choose a template or customize your style instructions below."
                />
                
                <div className="p-8 space-y-8">
                  {/* Templates Selection */}
                  <div className="space-y-4">
                    <div className="flex items-center justify-between px-1">
                      <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">ជ្រើសរើសគម្រូ (Choose Template)</label>
                      <button 
                        onClick={() => {
                          setCustomPrompt("Formal blue background CV photo, wearing professional suit.");
                          setSelectedTemplateId(null);
                        }}
                        className="text-[11px] font-bold text-[#6366F1] px-3 py-1.5 bg-indigo-50 rounded-xl hover:bg-indigo-100 transition-colors"
                      >
                        ប្រើប្រាស់ CV 4x6 ដើម
                      </button>
                    </div>
                    
                    <div className="space-y-3 max-h-[360px] overflow-y-auto pr-2 custom-scrollbar">
                      {userTemplates.map((template) => (
                        <motion.div
                          key={template.id}
                          whileHover={{ scale: 1.01 }}
                          whileTap={{ scale: 0.99 }}
                          onClick={() => {
                            setCustomPrompt(template.prompt);
                            setSelectedTemplateId(template.id);
                          }}
                          className={cn(
                            "flex items-center gap-4 bg-white p-3 rounded-3xl border cursor-pointer transition-all",
                            selectedTemplateId === template.id 
                              ? "border-[#6366F1] ring-4 ring-[#6366F1]/10 shadow-md translate-x-1" 
                              : "border-gray-100 hover:border-gray-200"
                          )}
                        >
                          <div className="w-20 h-20 rounded-2xl overflow-hidden flex-shrink-0 bg-gray-50 border border-gray-50">
                            {template.thumbnail ? (
                              <img src={template.thumbnail} alt={template.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-200">
                                <Layout size={24} />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0 pr-2">
                            <h4 className="font-bold text-gray-800 text-base truncate">{template.name}</h4>
                            <p className="text-xs text-gray-400 line-clamp-2 mt-1 italic leading-relaxed">
                              "{template.prompt}"
                            </p>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </div>

                  {/* Background Color Picker */}
                  <div className="space-y-4">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">ពណ៌ផ្ទៃខាងក្រោយ (Background Color)</label>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { id: "blue", label: "ផ្ទៃខៀវ", color: "bg-blue-600", border: "border-blue-200" },
                        { id: "white", label: "ផ្ទៃស", color: "bg-white", border: "border-gray-200" },
                        { id: "red", label: "ផ្ទៃក្រហម", color: "bg-red-600", border: "border-red-200" },
                      ].map((c) => (
                        <button
                          key={c.id}
                          onClick={() => setBgColor(c.id)}
                          className={cn(
                            "relative flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all",
                            bgColor === c.id 
                              ? "border-[#6366F1] bg-indigo-50/50 shadow-md scale-[1.02]" 
                              : "border-transparent bg-gray-50 hover:bg-gray-100 hover:border-gray-200"
                          )}
                        >
                          <div className={cn("w-10 h-10 rounded-full shadow-inner border-2", c.color, c.border)} />
                          <span className={cn("text-[10px] font-bold", bgColor === c.id ? "text-indigo-600" : "text-gray-500")}>
                            {c.label}
                          </span>
                          {bgColor === c.id && (
                            <div className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-[#6366F1] text-white rounded-full flex items-center justify-center border-2 border-white">
                              <Check size={10} strokeWidth={4} />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Nano Banana Pro & Clarity */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">របៀបពិសេស (Special Mode)</label>
                      <button
                        onClick={() => setIsNanoBananaPro(!isNanoBananaPro)}
                        className={cn(
                          "w-full flex items-center justify-between px-4 py-3 rounded-2xl transition-all border-2",
                          isNanoBananaPro 
                            ? "border-yellow-400 bg-yellow-50 text-yellow-700 shadow-sm" 
                            : "border-gray-100 bg-gray-50 text-gray-400 hover:bg-gray-100"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Sparkles size={16} className={isNanoBananaPro ? "text-yellow-500" : "text-gray-300"} />
                          <span className="font-bold text-sm">Nano Banana Pro</span>
                        </div>
                        <div className={cn(
                          "w-10 h-5 rounded-full relative transition-colors",
                          isNanoBananaPro ? "bg-yellow-400" : "bg-gray-200"
                        )}>
                          <div className={cn(
                            "absolute top-1 w-3 h-3 bg-white rounded-full transition-all",
                            isNanoBananaPro ? "left-6" : "left-1"
                          )} />
                        </div>
                      </button>
                    </div>

                    <div className="space-y-3">
                      <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">កម្រិតរូបភាព (Clarity)</label>
                      <div className="flex bg-gray-50 p-1 rounded-2xl border border-gray-100">
                        {(["standard", "ultra"] as const).map((level) => (
                          <button
                            key={level}
                            onClick={() => setClarityLevel(level)}
                            className={cn(
                              "flex-1 py-2 rounded-xl text-xs font-bold transition-all",
                              clarityLevel === level 
                                ? "bg-white text-[#6366F1] shadow-sm" 
                                : "text-gray-400 hover:text-gray-600"
                            )}
                          >
                            {level === "standard" ? "ធម្មតា" : "ច្បាស់ពិសេស (Ultra)"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Prompt Textarea */}
                  {showCustomPromptArea && (
                    <div className="space-y-3">
                      <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">ការណែនាំបន្ថែម (Custom Prompt)</label>
                      <textarea
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        placeholder="ឧទាហរណ៍៖ ប្តូរអាវសិស្សសាលា, ប្តូរជាឈុតអាវធំ, បន្ថែមស្នាមញញឹម..."
                        className="w-full h-32 p-4 bg-gray-50 border border-gray-100 rounded-2xl focus:ring-4 focus:ring-[#6366F1]/5 focus:border-[#6366F1] outline-none transition-all resize-none text-sm leading-relaxed"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* History Preview (Left Column Bottom) */}
              <div className="bg-white rounded-[2.5rem] shadow-sm border border-gray-100 overflow-hidden">
                <SectionHeader 
                  icon={History}
                  title="ប្រវត្តិរូបភាព (Recent History)"
                  subtitle="Displaying your last 8 generated studio portraits."
                />

                <div className="p-8">
                  <div className="flex items-center justify-end mb-6">
                    {history.length > 0 && (
                      <button 
                        onClick={clearAllHistory}
                        className="text-xs font-bold text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-xl transition-colors bg-red-50/50"
                      >
                        លុបទាំងអស់
                      </button>
                    )}
                  </div>

                  {history.length > 0 ? (
                    <div className="grid grid-cols-2 gap-4">
                      {history.slice(0, 8).map((img) => (
                        <div key={img.id} className="relative aspect-[3/4] rounded-2xl overflow-hidden group border border-gray-100 shadow-sm">
                          <img src={img.url} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                            <button 
                              onClick={() => setGeneratedResult(img.url)}
                              className="p-2.5 bg-white text-gray-900 rounded-xl hover:scale-110 transition-transform shadow-lg"
                            >
                              <Layout size={18} />
                            </button>
                            <button 
                              onClick={() => deleteHistoryItem(img.id)}
                              className="p-2.5 bg-red-500 text-white rounded-xl hover:scale-110 transition-transform shadow-lg"
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-12 flex flex-col items-center justify-center text-center space-y-4">
                      <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center text-gray-300">
                        <History size={32} />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-gray-500 italic">មិនមានប្រវត្តិរូបភាពទេ (No history found)</p>
                        <p className="text-[10px] text-gray-400 max-w-[200px] mx-auto leading-relaxed">
                          {!currentUser ? "សូមចូលប្រើប្រាស់ (Login) ដើម្បីរក្សាទុកប្រវត្តិរូបភាព" : "សាកល្បងបង្កើតរូបភាពថ្មីដើម្បីមើលវានៅទីនេះ"}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right Column: Upload & Result */}
            <div className="space-y-8">
              <div className="bg-white rounded-[2.5rem] shadow-sm border border-gray-100 overflow-hidden">
                <SectionHeader 
                  icon={ImageIcon}
                  title="ពីរបភាពធម្មតាទៅ CV 4x6 ផ្ទៃខៀវ"
                  subtitle="Upload a photo and generate a studio-style result from the selected mode."
                />
                
                <div className="p-8 space-y-8">
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "aspect-[3/4] max-w-sm mx-auto border-2 border-dashed rounded-3xl flex flex-col items-center justify-center cursor-pointer transition-all overflow-hidden relative group",
                    uploadedImage ? "border-[#6366F1] bg-indigo-50/10 shadow-inner" : "border-gray-200 bg-gray-50 hover:bg-gray-100"
                  )}
                >
                  {uploadedImage ? (
                    <>
                      <img src={uploadedImage} alt="Uploaded" className="w-full h-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex justify-center">
                        <span className="flex items-center gap-2 bg-white px-4 py-2 rounded-full text-xs font-bold shadow-lg">
                          <Plus size={14} /> ប្តូររូបភាពថ្មី
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="text-center space-y-4 p-8">
                      <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center mx-auto text-gray-400">
                        <ImageIcon size={32} />
                      </div>
                      <div className="space-y-1">
                        <p className="font-bold text-gray-600">ចុចដើម្បីបញ្ចូលរូបថត</p>
                        <p className="text-xs text-gray-400 italic">រូបថតសន្លឹកដែលឃើញមុខច្បាស់</p>
                      </div>
                    </div>
                  )}
                  <input type="file" ref={fileInputRef} onChange={handleImageUpload} className="hidden" accept="image/*" />
                </div>

                <div className="space-y-6">
                  <button
                    onClick={handleGenerate}
                    disabled={isGenerating || !uploadedImage}
                    className={cn(
                      "w-full py-5 rounded-2xl flex items-center justify-center gap-3 font-bold text-xl transition-all shadow-xl",
                      isGenerating || !uploadedImage
                        ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                        : "bg-[#6366F1] text-white hover:bg-indigo-600 hover:scale-[1.01] active:scale-[0.99] shadow-indigo-500/20"
                    )}
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="animate-spin" size={24} />
                        <span>កំពុងបង្កើត...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={24} />
                        <span>បង្កើតរូបថត CV ឥឡូវនេះ</span>
                      </>
                    )}
                  </button>

                  <AnimatePresence mode="wait">
                    {generatedResult && (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-4 pt-4"
                      >
                        <div className="flex items-center justify-between px-2">
                          <h3 className="font-bold text-gray-800">លទ្ធផលសម្រេច</h3>
                          <button 
                            onClick={() => {
                              if (generatedResult) {
                                downloadFile(generatedResult, `cv-portrait-${Date.now()}.png`);
                              }
                            }}
                            className="flex items-center gap-2 text-sm font-bold text-[#6366F1] hover:underline"
                          >
                            <Download size={18} /> ទាញយករូបភាព
                          </button>
                        </div>
                        <div className="aspect-[3/4] max-w-sm mx-auto rounded-3xl overflow-hidden shadow-2xl ring-4 ring-white relative group">
                          <img src={generatedResult} alt="Generated" className="w-full h-full object-cover" />
                          <div className="absolute top-4 right-4 animate-bounce">
                             <div className="bg-green-500 text-white p-2 rounded-full shadow-lg">
                               <Sparkles size={16} />
                             </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
        </motion.div>
      )}


      {activeTab === "admin" && isAdmin() && (
        <motion.div 
          key="admin-tab"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          className="max-w-7xl mx-auto px-6 pb-20"
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Template Editor */}
            <div className="lg:col-span-1 space-y-6">
              {/* Global Settings */}
              <div className="bg-white rounded-3xl p-6 shadow-xl border border-gray-100 space-y-6">
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-2 bg-indigo-50 rounded-xl text-[#6366F1]">
                    <Settings size={20} />
                  </div>
                  <h3 className="font-bold text-gray-800">Global Settings</h3>
                </div>
                
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-gray-700">Custom Prompt</p>
                    <p className="text-[10px] text-gray-400 font-medium">Toggle custom prompt visibility</p>
                  </div>
                  <button
                    onClick={() => {
                      const newValue = !showCustomPromptArea;
                      setShowCustomPromptArea(newValue);
                      updateSetting("showCustomPromptArea", newValue);
                    }}
                    className={cn(
                      "w-12 h-6 rounded-full relative transition-colors",
                      showCustomPromptArea ? "bg-[#6366F1]" : "bg-gray-200"
                    )}
                  >
                    <div className={cn(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                      showCustomPromptArea ? "left-7" : "left-1"
                    )} />
                  </button>
                </div>
              </div>

              <div className="bg-white rounded-3xl shadow-xl p-6 space-y-6">
                <div className="flex items-center gap-2 text-[#6366F1]">
                  <Plus size={20} />
                  <h3 className="font-bold text-lg">{editingTemplateId ? "កែសម្រួលគម្រូ" : "បន្ថែមគម្រូថ្មី"}</h3>
                </div>
                {currentUser && (
                  <div className="mx-6 mt-1 px-3 py-2 bg-indigo-50 text-indigo-700 text-[10px] rounded-xl font-bold flex items-center gap-2 border border-indigo-100">
                    <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
                    Status: Signed in as {currentUser.email}
                  </div>
                )}

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">ឈ្មោះគម្រូ (Template Name)</label>
                    <input 
                      type="text"
                      value={newTemplateName}
                      onChange={(e) => setNewTemplateName(e.target.value)}
                      placeholder="ឧទាហរណ៍៖ អាវសិស្សសាលា"
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-sm outline-none focus:border-[#6366F1] focus:ring-4 focus:ring-[#6366F1]/5 transition-all"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Promt សម្រាប់គម្រូ (Template Prompt)</label>
                    <textarea 
                      value={newTemplatePrompt}
                      onChange={(e) => setNewTemplatePrompt(e.target.value)}
                      placeholder="ឧទាហរណ៍៖ wear a white school uniform shirt..."
                      className="w-full h-32 px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-sm outline-none focus:border-[#6366F1] focus:ring-4 focus:ring-[#6366F1]/5 transition-all resize-none"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">រូបភាពគម្រូ (Thumbnail)</label>
                    <div 
                      onClick={() => templateThumbRef.current?.click()}
                      className="aspect-square w-full bg-gray-50 border-2 border-dashed border-gray-200 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-100 transition-all overflow-hidden relative"
                    >
                      {newTemplateThumbnail ? (
                        <img src={newTemplateThumbnail} alt="Thumb" className="w-full h-full object-cover" />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-gray-400">
                          <Upload size={24} />
                          <span className="text-xs font-bold">Upload Thumbnail</span>
                        </div>
                      )}
                    </div>
                    <input type="file" ref={templateThumbRef} onChange={handleThumbnailUpload} className="hidden" accept="image/*" />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">រូបភាពយោង (Reference - Ex: Shirt Style)</label>
                    <div 
                      onClick={() => referenceImgRef.current?.click()}
                      className="aspect-square w-full bg-gray-50 border-2 border-dashed border-gray-200 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-100 transition-all overflow-hidden relative"
                    >
                      {newTemplateReferenceImage ? (
                        <img src={newTemplateReferenceImage} alt="Ref" className="w-full h-full object-cover" />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-gray-400 p-4 text-center">
                          <ImageIcon size={24} />
                          <span className="text-xs font-bold">Upload Reference Image (Optional)</span>
                        </div>
                      )}
                    </div>
                    <input type="file" ref={referenceImgRef} onChange={handleReferenceUpload} className="hidden" accept="image/*" />
                  </div>

                  <div className="flex gap-3 pt-2">
                    {editingTemplateId && (
                      <button 
                        onClick={() => {
                          setEditingTemplateId(null);
                          setNewTemplateName("");
                          setNewTemplatePrompt("");
                          setNewTemplateThumbnail(null);
                        }}
                        className="flex-1 py-3 border border-gray-200 text-gray-500 font-bold rounded-2xl hover:bg-gray-50 transition-all"
                      >
                        Cancel
                      </button>
                    )}
                    <button 
                      onClick={saveTemplate}
                      disabled={!newTemplateName || !newTemplatePrompt || isSavingTemplate}
                      className="flex-[2] py-3 bg-[#6366F1] text-white font-bold rounded-2xl disabled:opacity-50 hover:bg-indigo-600 shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-2"
                    >
                      {isSavingTemplate && <Loader2 size={16} className="animate-spin" />}
                      {editingTemplateId ? "Update Template" : "Save Template"}
                    </button>
                  </div>
                  {saveStatus && (
                    <div className={cn(
                      "mt-2 text-[10px] font-bold text-center px-4 py-2 rounded-xl transition-all animate-pulse",
                      saveStatus.includes("បរាជ័យ") ? "bg-red-50 text-red-500" : "bg-green-50 text-green-600"
                    )}>
                      {saveStatus}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Template List */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-3xl shadow-xl p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2 text-gray-800">
                    <Layout size={20} className="text-[#6366F1]" />
                    <h3 className="font-bold text-lg">បញ្ជីគម្រូទាំងអស់ ({userTemplates.length})</h3>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {userTemplates.map((template) => (
                    <div key={template.id} className="flex gap-4 p-4 border border-gray-100 rounded-2xl hover:border-indigo-100 hover:bg-indigo-50/30 transition-all group">
                      <div className="w-20 h-20 rounded-xl overflow-hidden bg-gray-100 flex-shrink-0">
                        {template.thumbnail ? (
                          <img src={template.thumbnail} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-300">
                            <Layout size={24} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div>
                          <h4 className="font-bold text-gray-800 truncate">{template.name}</h4>
                          <p className="text-xs text-gray-400 line-clamp-2 mt-1">{template.prompt}</p>
                        </div>
                        <div className="flex gap-2 mt-2">
                          <button 
                            onClick={() => startEditing(template)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-indigo-50 text-[#6366F1] rounded-lg text-[10px] font-bold hover:bg-indigo-100 transition-all"
                          >
                            <Pencil size={12} />
                            Edit
                          </button>
                          {deletingTemplateId === template.id ? (
                            <div className="flex gap-1 animate-pulse">
                              <button 
                                onClick={() => confirmDeleteTemplate(template.id)}
                                className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-lg text-[10px] font-bold hover:bg-red-700 transition-all shadow-sm"
                              >
                                Confirm Delete
                              </button>
                              <button 
                                onClick={() => setDeletingTemplateId(null)}
                                className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-[10px] font-bold hover:bg-gray-200 transition-all"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button 
                              onClick={(e) => deleteTemplate(template.id, e)}
                              className="flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-500 rounded-lg text-[10px] font-bold hover:bg-red-100 transition-all"
                            >
                              <Trash2 size={12} />
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {userTemplates.length === 0 && (
                    <div className="col-span-full py-12 text-center text-gray-400 italic">
                      មិនទាន់មានគម្រូនៅឡើយទេ។ សូមបន្ថែមគម្រូថ្មីនៅផ្នែកខាងឆ្វេង។
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {/* User Management */}
            <div className="lg:col-span-3 space-y-6 mt-4">
              <div className="bg-white rounded-3xl shadow-xl p-6 border border-gray-100">
                <div className="flex items-center gap-2 mb-6">
                  <div className="p-2 bg-indigo-50 rounded-xl text-[#6366F1]">
                    <UserIcon size={20} />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-800 tracking-tight">គ្រប់គ្រងអ្នកប្រើប្រាស់ (User Management)</h3>
                    <p className="text-[10px] text-gray-400 font-bold uppercase mt-0.5 tracking-widest">រៀបចំសិទ្ធិអ្នកប្រើប្រាស់</p>
                  </div>
                </div>
                
                <div className="overflow-x-auto rounded-2xl border border-gray-100 shadow-sm">
                  <table className="w-full text-sm text-left border-collapse">
                    <thead className="bg-[#6366F1] text-white uppercase text-[10px] font-bold tracking-widest">
                      <tr>
                        <th className="px-6 py-4 rounded-tl-xl">Email</th>
                        <th className="px-6 py-4">UID (ID)</th>
                        <th className="px-6 py-4 text-center">Role</th>
                        <th className="px-6 py-4 rounded-tr-xl text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {allUsers.map(user => (
                        <tr key={user.uid} className="hover:bg-gray-50/50 transition-colors group">
                          <td className="px-6 py-4 font-semibold text-gray-800">{user.email || "No Email"}</td>
                          <td className="px-6 py-4 text-xs text-gray-400 font-mono tracking-tighter">{user.uid}</td>
                          <td className="px-6 py-4 text-center">
                            <span className={cn(
                              "px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm", 
                              user.role === "admin" ? "bg-[#6366F1] text-white" : "bg-gray-100 text-gray-600"
                            )}>
                              {user.role || 'user'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <div className="flex justify-center gap-2 opacity-100 lg:opacity-50 lg:group-hover:opacity-100 transition-opacity">
                              {user.role === "admin" ? (
                                <button
                                  disabled={user.email?.toLowerCase() === "henrythonny@gmail.com".toLowerCase()}
                                  onClick={() => updateUserRole(user.uid, "user")}
                                  className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-[10px] font-bold hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                                >
                                  Make User
                                </button>
                              ) : (
                                <button
                                  onClick={() => updateUserRole(user.uid, "admin")}
                                  className="px-4 py-2 bg-[#6366F1] text-white rounded-xl text-[10px] font-bold hover:bg-indigo-600 shadow-md shadow-indigo-500/20 transition-all"
                                >
                                  Make Admin
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {allUsers.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-6 py-12 text-center text-gray-400 italic">
                            កំពុងទាញយកទិន្នន័យអ្នកប្រើប្រាស់... (Loading users...)
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

          </div>
        </motion.div>
      )}

      {activeTab === "map-qr" && (
        <motion.div 
          key="map-qr-tab"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="max-w-3xl mx-auto px-6 pb-20"
        >
          <div className="bg-white rounded-[2.5rem] shadow-sm border border-gray-100 overflow-hidden">
            <SectionHeader 
              icon={MapPin}
              title="បង្កើត QR Code សម្រាប់ទីតាំង Mape"
              subtitle="Paste your Google Maps URL below to generate a stylized QR code."
            />
            
            <div className="p-8 space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div className="space-y-4">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">URL នៃទីតាំង (Map URL)</label>
                    <div className="relative group">
                      <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-gray-400 group-focus-within:text-[#6366F1] transition-colors">
                        <MapPin size={20} />
                      </div>
                      <input 
                        type="text"
                        value={mapUrl}
                        onChange={(e) => setMapUrl(e.target.value)}
                        placeholder="https://maps.app.goo.gl/..."
                        className="w-full pl-12 pr-4 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:ring-4 focus:ring-[#6366F1]/5 focus:border-[#6366F1] outline-none transition-all text-sm font-medium"
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">ពណ៌ (QR Color)</label>
                    <div className="flex flex-wrap gap-3">
                      {["#6366F1", "#000000", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6"].map((color) => (
                        <button
                          key={color}
                          onClick={() => setQrColor(color)}
                          className={cn(
                            "w-10 h-10 rounded-xl border-2 transition-all",
                            qrColor === color ? "border-indigo-600 scale-110 shadow-md" : "border-transparent"
                          )}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                      <input 
                        type="color" 
                        value={qrColor} 
                        onChange={(e) => setQrColor(e.target.value)}
                        className="w-10 h-10 rounded-xl cursor-pointer border-2 border-transparent bg-white shadow-sm"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <button
                      onClick={() => setIncludeLogo(!includeLogo)}
                      className={cn(
                        "flex items-center justify-between p-4 rounded-2xl border-2 transition-all",
                        includeLogo ? "bg-indigo-50 border-[#6366F1] text-indigo-700" : "bg-gray-50 border-transparent text-gray-500"
                      )}
                    >
                      <span className="text-xs font-bold">ដាក់ Logo</span>
                      <div className={cn("w-4 h-4 rounded-full border-2", includeLogo ? "bg-indigo-600 border-indigo-200" : "bg-white border-gray-300")} />
                    </button>
                    <button
                      onClick={() => setQrFrame(!qrFrame)}
                      className={cn(
                        "flex items-center justify-between p-4 rounded-2xl border-2 transition-all",
                        qrFrame ? "bg-indigo-50 border-[#6366F1] text-indigo-700" : "bg-gray-50 border-transparent text-gray-500"
                      )}
                    >
                      <span className="text-xs font-bold">ដាក់ស៊ុម</span>
                      <div className={cn("w-4 h-4 rounded-full border-2", qrFrame ? "bg-indigo-600 border-indigo-200" : "bg-white border-gray-300")} />
                    </button>
                  </div>
                </div>

                <div className="flex flex-col items-center justify-center">
                  {mapUrl ? (
                    <div className="space-y-6 w-full flex flex-col items-center">
                      <div className={cn(
                        "p-8 bg-white rounded-[2.5rem] shadow-2xl transition-all",
                        qrFrame ? "ring-8 ring-indigo-50" : "ring-0"
                      )}>
                        <div className="relative">
                          {/* Single High-Res Canvas scaled down for preview */}
                          <div style={{ width: '220px', height: '220px' }}>
                            <QRCodeCanvas 
                              id="qr-map-canvas"
                              value={mapUrl}
                              size={500} // High res internal size
                              style={{ width: '220px', height: '220px' }} // Visual size in UI
                              fgColor={qrColor}
                              bgColor="transparent"
                              level="H"
                              includeMargin={true}
                              imageSettings={includeLogo ? {
                                src: qrLogoDataUrl,
                                height: 100,
                                width: 100,
                                excavate: true,
                                crossOrigin: "anonymous",
                              } : undefined}
                            />
                          </div>
                        </div>
                      </div>
                      
                      <div className="text-center space-y-4">
                        <div className="space-y-1">
                          <p className="font-black text-gray-900 uppercase tracking-tight">Scan for Location</p>
                          <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Google Maps Ready • 500px High-Res</p>
                        </div>
                        
                        <button
                          onClick={() => {
                            const canvas = document.getElementById('qr-map-canvas') as HTMLCanvasElement;
                            if (canvas) {
                              try {
                                // Create an off-screen canvas for the final export
                                const exportCanvas = document.createElement('canvas');
                                const ctx = exportCanvas.getContext('2d');
                                if (!ctx) return;

                                const qrSize = 500;
                                const outlineWidth = 10;
                                const padding = 20; // Internal spacing
                                const frameOffset = 10; // Outer border thickness
                                const qrPadding = 5; // The requested 5px gap
                                const bottomSpace = qrFrame ? 160 : 0;

                                // Set dimensions
                                exportCanvas.width = qrSize + (qrPadding * 2) + (padding * 2);
                                exportCanvas.height = qrSize + (qrPadding * 2) + (padding * 2) + bottomSpace;

                                if (qrFrame) {
                                  // Draw Frame Background (Outer Outline)
                                  ctx.fillStyle = qrColor;
                                  const radius = 50;
                                  ctx.beginPath();
                                  ctx.roundRect(0, 0, exportCanvas.width, exportCanvas.height, radius);
                                  ctx.fill();

                                  // Draw 10px outline (inner border effect)
                                  ctx.strokeStyle = "rgba(255,255,255,0.2)";
                                  ctx.lineWidth = outlineWidth;
                                  ctx.stroke();

                                  // Internal White Area for QR - adjusted for 5px padding
                                  ctx.fillStyle = "white";
                                  ctx.beginPath();
                                  ctx.roundRect(padding - qrPadding, padding - qrPadding, qrSize + (qrPadding * 2), qrSize + (qrPadding * 2), radius - 15);
                                  ctx.fill();

                                  // Draw "SCAN ME" text
                                  ctx.fillStyle = "white";
                                  ctx.font = "bold 60px Inter, sans-serif";
                                  ctx.textAlign = "center";
                                  ctx.textBaseline = "middle";
                                  ctx.fillText("SCAN ME", exportCanvas.width / 2, exportCanvas.height - (bottomSpace / 2) + 5);
                                  
                                  // Little triangle pointer
                                  ctx.beginPath();
                                  ctx.moveTo(exportCanvas.width / 2 - 25, qrSize + padding + qrPadding + 10);
                                  ctx.lineTo(exportCanvas.width / 2 + 25, qrSize + padding + qrPadding + 10);
                                  ctx.lineTo(exportCanvas.width / 2, qrSize + padding + qrPadding + 45);
                                  ctx.fill();
                                } else {
                                  // Fully transparent background if no frame
                                  ctx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
                                }

                                // Draw the actual QR code
                                ctx.drawImage(canvas, padding, padding, qrSize, qrSize);

                                const dataUrl = exportCanvas.toDataURL("image/png", 1.0);
                                downloadFile(dataUrl, `map-qr-framed-${Date.now()}.png`);
                              } catch (e: any) {
                                console.error("Export error:", e);
                                if (e.name === "SecurityError" || e.message?.includes("tainted")) {
                                  alert("មិនអាចទាញយកបានដោយសារបញ្ហាសុវត្ថិភាពរូបភាព Logo។ សូមព្យាយាមបិទ 'ដាក់ Logo' រួចសាកល្បងម្តងទៀត ឬចុចឱ្យយូរលើរូបភាពដើម្បី Save Image។");
                                } else {
                                  alert("មានបញ្ហាក្នុងការទាញយក។ សូមព្យាយាមចុចឱ្យយូរលើរូបភាពដើម្បី Save Image។");
                                }
                              }
                            } else {
                              alert("រកមិនឃើញរូបភាពសម្រាប់ទាញយកទេ (Canvas not found)");
                            }
                          }}
                          className="flex items-center gap-3 px-10 py-4 bg-gray-900 text-white rounded-[1.5rem] font-bold shadow-xl hover:bg-black transition-all active:scale-95 text-sm"
                        >
                          <Download size={18} />
                          ទាញយក QR Code (500px)
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="w-full aspect-square flex flex-col items-center justify-center p-12 bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-100 text-center space-y-4">
                      <div className="w-20 h-20 bg-white rounded-3xl shadow-sm flex items-center justify-center text-gray-200">
                        <MapPin size={40} />
                      </div>
                      <p className="text-xs text-gray-400 italic px-4">បញ្ចូល URL នៃទីតាំង Map ដើម្បីបង្ហាញ QR Code</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettingsModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] w-full max-w-md overflow-hidden shadow-2xl relative"
            >
              <div className="p-8 space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold flex items-center gap-2">
                    <Settings className="text-[#6366F1]" />
                    API
                  </h3>
                  <button onClick={() => setShowSettingsModal(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500">
                    <X size={20} />
                  </button>
                </div>
                
                <div className="space-y-4">
                      <div className="bg-indigo-50 p-6 rounded-3xl border border-indigo-100">
                        <h4 className="text-sm font-bold text-indigo-900 mb-3 flex items-center gap-2">
                          <Layout size={16} />
                          របៀបយក API Key ឥតគិតថ្លៃ៖
                        </h4>
                        <ol className="list-decimal pl-5 text-xs text-indigo-800 space-y-2 leading-relaxed">
                          <li>ចូលទៅកាន់ <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline font-bold hover:text-indigo-600 transition-colors">aistudio.google.com</a></li>
                          <li>ចុចប៊ូតុង "Create API key"</li>
                          <li>ចម្លង Key នោះមកបញ្ចូលក្នុងប្រអប់ខាងក្រោម</li>
                        </ol>
                      </div>
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
                          Gemini API Key
                        </label>
                        <p className="text-[11px] text-gray-500 bg-gray-50 p-3 rounded-xl border border-gray-100">
                          បញ្ចូល API Key លោកអ្នកដើម្បីប្រើប្រាស់ការបង្កើតរូបភាពដោយឥគិតថ្លៃ ១០០%។ បើគ្មាន Key ទេ លោកអ្នកមិនអាចបង្កើតរូបភាពបានឡើយ។
                        </p>
                        <input 
                          type="password"
                          value={localApiKey}
                          onChange={(e) => setLocalApiKey(e.target.value)}
                          placeholder="បញ្ចូល API Key នៅទីនេះ (ឧ៖ AIzaSy...)"
                          className="w-full px-5 py-4 bg-white border border-gray-200 rounded-2xl text-sm outline-none focus:border-[#6366F1] focus:ring-4 focus:ring-[#6366F1]/5 transition-all shadow-sm"
                        />
                      </div>
                  
                  {(typeof window !== 'undefined' && 'aistudio' in window) && (
                    <div className="pt-2">
                      <div className="relative flex items-center mb-4">
                        <div className="flex-grow border-t border-gray-200"></div>
                        <span className="flex-shrink-0 mx-4 text-gray-400 text-xs font-medium">ឬជ្រើសរើសដោយស្វ័យប្រវត្តិ</span>
                        <div className="flex-grow border-t border-gray-200"></div>
                      </div>
                      <button 
                        onClick={async () => {
                          try {
                            await (window as any).aistudio.openSelectKey();
                            setShowSettingsModal(false);
                          } catch (err) {
                            console.error("Failed to open select key dialog", err);
                          }
                        }}
                        className="w-full py-3 bg-[#6366F1] text-white rounded-2xl font-bold hover:bg-indigo-600 transition-all active:scale-95 text-sm"
                      >
                        ជ្រើសរើស API Key ពី AI Studio (ស្វ័យប្រវត្តិ)
                      </button>
                    </div>
                  )}
                </div>

                <div className="pt-4 flex gap-3">
                  <button
                    onClick={() => {
                      if (localApiKey.trim()) {
                        localStorage.setItem('gemini_api_key', localApiKey.trim());
                      } else {
                        localStorage.removeItem('gemini_api_key');
                      }
                      setShowSettingsModal(false);
                      // Force page reload might be needed to apply the change fully immediately, or we can just rely on the next fetch call
                    }}
                    className="flex-1 py-4 bg-[#6366F1] text-white rounded-2xl font-bold hover:bg-indigo-600 shadow-lg shadow-indigo-500/20 transition-all active:scale-95"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
