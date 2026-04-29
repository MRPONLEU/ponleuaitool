export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  category: string;
  thumbnail: string;
  cost: number;
  used: number;
}

export const DEFAULT_TEMPLATES: PromptTemplate[] = [];
