import { GoogleGenAI } from "@google/genai";

export const generateImage = async (
  prompt: string, 
  aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" = "1:1",
  images: string[] = [] // array of base64 strings
) => {
  const customApiKey = localStorage.getItem('gemini_api_key');
  
  // @ts-ignore
  const apiKey = customApiKey || process.env.API_KEY || import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("API Key is missing. Please provide an API Key.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const parts: any[] = [{ text: prompt }];
  
  for (const img of images) {
    if (img) {
      // Remove data:image/...;base64, prefix if present
      const base64Data = img.split(',')[1] || img;
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Data,
        },
      });
    }
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: { parts },
      config: {
        imageConfig: {
          aspectRatio,
        },
      },
    });

    let imageData = null;
    if (response.candidates && response.candidates.length > 0) {
      for (const part of response.candidates[0].content?.parts || []) {
        if (part.inlineData) {
          imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (imageData) {
      return imageData;
    }
    throw new Error("No image generated.");

  } catch (error: any) {
    console.error("Gemini Image generation error:", error);
    const isQuotaOrPermission = 
      error.status === 429 || 
      error.status === 403 ||
      error.message?.includes("429") || 
      error.message?.toLowerCase().includes("quota") || 
      error.message?.includes("RESOURCE_EXHAUSTED") ||
      error.message?.toLowerCase().includes("permission denied");
      
    if (isQuotaOrPermission) {
      throw new Error(`QUOTA_EXCEEDED: ${error.message}`);
    }
    throw error;
  }
};


