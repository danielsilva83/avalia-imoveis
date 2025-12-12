import { GoogleGenAI } from "@google/genai";
import { PropertyFormData, AnalysisResponse } from "../types";

const parseResponse = (text: string): AnalysisResponse => {
  const result: AnalysisResponse = {
    priceAnalysis: "",
    salesScripts: [],
    knowledgePill: "",
    crmData: {
      resumo_imovel: "Erro na análise",
      faixa_preco_sugerida: "N/A",
      nivel_dificuldade_venda: "N/A",
      tags_sugeridas: []
    }
  };

  try {
    // Extract sections using the delimiters defined in system instructions
    // Note: We use a regex that matches the delimiters [[SEÇÃO X]]
    const sections = text.split(/\[\[SEÇÃO \d\]\]/);
    
    // sections[0] is usually empty or pre-amble
    // [[SEÇÃO 1]] content -> sections[1]
    // [[SEÇÃO 2]] content -> sections[2]
    // [[SEÇÃO 3]] content -> sections[3]
    // [[SEÇÃO 4]] content -> sections[4]

    if (sections.length > 1) {
      result.priceAnalysis = sections[1].trim();
    }

    if (sections.length > 2) {
      const scriptsText = sections[2].trim();
      // Split by newline and clean up bullet points or quotes
      result.salesScripts = scriptsText
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => s.replace(/^[-*•"']\s*/, '').replace(/["']$/, '')); // Remove leading bullets/quotes and trailing quotes
    }

    if (sections.length > 3) {
      result.knowledgePill = sections[3].trim();
    }

    if (sections.length > 4) {
      let jsonText = sections[4].trim();
      // Remove markdown code blocks if present
      jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '');
      
      const start = jsonText.indexOf('{');
      const end = jsonText.lastIndexOf('}');
      
      if (start !== -1 && end !== -1) {
         const cleanJson = jsonText.substring(start, end + 1);
         try {
            result.crmData = JSON.parse(cleanJson);
         } catch (jsonError) {
            console.warn("JSON parsing failed. Attempting cleanup...", jsonError);
            // Fallback: Try to replace single quotes with double quotes for keys if simple mismatch
            // This is a naive fix for { 'key': 'value' } style commonly returned by LLMs
            try {
              const fixedJson = cleanJson.replace(/'/g, '"');
              result.crmData = JSON.parse(fixedJson);
            } catch (e) {
               console.error("Failed to recover JSON:", cleanJson);
            }
         }
      }
    }
  } catch (error) {
    console.error("Error parsing response:", error);
    // Fallback happens via default initializers
  }

  return result;
};

export const analyzeProperty = async (data: PropertyFormData): Promise<AnalysisResponse> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key not found in environment variables.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const transactionContext = data.transactionType === 'aluguel' ? 'LOCAÇÃO/ALUGUEL' : 'VENDA';
  const priceContext = data.transactionType === 'aluguel' ? 'Valor do Aluguel Mensal' : 'Preço de Venda Total';

  // Format amenities list
  const amenities = [
    data.isCondo ? 'Em Condomínio Fechado' : null,
    data.isFurnished ? 'Mobiliado' : null,
    data.hasPool ? 'Com Piscina Privativa' : null,
    data.hasBackyard ? 'Com Quintal' : null,
    data.hasGarden ? 'Com Jardim' : null,
    data.hasAirConditioning ? 'Com Ar-condicionado' : null
  ].filter(Boolean).join(', ');

  const prompt = `
    Analise o seguinte imóvel para fins de **${transactionContext}**:
    
    DETALHES DO IMÓVEL:
    - Tipo: ${data.type}
    - Localização: ${data.location}
    - Tamanho: ${data.size}m²
    - Quartos: ${data.rooms}
    - Suítes: ${data.suites}
    - Vagas de Garagem: ${data.garage}
    - Estado de Conservação: ${data.condition}
    - Diferenciais/Comodidades: ${amenities || 'Nenhuma informada'}
    - ${priceContext} Pedido pelo Dono: R$ ${data.price.toLocaleString('pt-BR')}

    Utilize o Google Search para encontrar dados RECENTES de mercado nessa região (custo m², imóveis similares com essas características).
    Considere fortemente o impacto das comodidades (ex: piscina, vagas extras, mobília) na valorização ou facilidade de ${data.transactionType === 'venda' ? 'venda' : 'locação'}.
  `;

  const systemInstruction = `
    Você é o "AvalIA", um Assistente de avaliação de preços de imóveis e Inteligência de Mercado para corretores.

    OBJETIVO:
    Analisar dados detalhados de um imóvel, estimar a precificação com base em tendências de mercado (considere o contexto brasileiro) e fornecer argumentos irrefutáveis para convencer o proprietário, enquanto educa o corretor.

    CONTEXTO DA TRANSAÇÃO:
    O usuário está analisando um imóvel para **${transactionContext}**. 
    Se for LOCAÇÃO, foque em valor do pacote, yield (retorno), demanda de inquilinos e preço do aluguel/m². Considere se estar mobiliado aumenta o valor ou liquidez.
    Se for VENDA, foque em liquidez, valor do m² de venda e comparativos. Considere quanto lazer (piscina, quintal) ou segurança (condomínio) agregam ao preço.

    PERFIL DE RESPOSTA (Mobile-First):
    1. Seja direto e visual (use bullet points e emojis).
    2. Evite blocos de texto longos.
    3. Tom de voz: Profissional, encorajador e baseado em dados.

    IMPORTANTE:
    Você DEVE usar a ferramenta 'googleSearch' para fundamentar sua análise em dados reais de portais imobiliários (VivaReal, Zap, OLX, etc) da região especificada.

    ESTRUTURA DE SAÍDA OBRIGATÓRIA:
    Use EXATAMENTE os delimitadores abaixo para separar as seções.

    [[SEÇÃO 1]]
    Análise de Preço (Para o Proprietário).
    - Estime uma faixa de preço (Mínimo - Ideal - Teto) para ${transactionContext}.
    - Destaque 3 pontos fortes e 2 pontos de atenção do imóvel. CITE especificamente se as comodidades (ar, piscina, garagem) estão ajudando ou faltando.
    - Use formatação Markdown simples e legível.

    [[SEÇÃO 2]]
    Argumentos de Autoridade (Script de Negociação).
    - Forneça 2 frases curtas e diretas que o corretor deve dizer ao proprietário para justificar o ajuste de valor.
    - Escreva uma frase por linha.

    [[SEÇÃO 3]]
    Pílula de Conhecimento (Treinamento Embutido).
    - Explique brevemente (max 2 frases) um conceito técnico relevante para ${transactionContext}. Exemplo: Impacto de "Mobiliado" no Yield, Valorização de vagas de garagem na região, etc.

    [[SEÇÃO 4]]
    CRM Data (JSON).
    - Gere um objeto JSON válido seguindo estritamente a sintaxe JSON (RFC 8259).
    - IMPORTANTE: Use aspas duplas ("") para todas as chaves e valores string.
    - Exemplo de estrutura:
    {
      "resumo_imovel": "Texto resumido...",
      "faixa_preco_sugerida": "R$ X - R$ Y",
      "nivel_dificuldade_venda": "Alto/Médio/Baixo",
      "tags_sugeridas": ["Tag1", "Tag2"]
    }
    - NÃO use blocos de código markdown. Retorne apenas o objeto JSON cru.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", 
      contents: prompt,
      config: {
        systemInstruction: systemInstruction,
        tools: [{ googleSearch: {} }],
        // responseMimeType: "application/json" cannot be used with tools
        temperature: 0.7, 
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error("No response from Gemini");
    }

    return parseResponse(text);
  } catch (error) {
    console.error("Error calling Gemini:", error);
    throw error;
  }
};