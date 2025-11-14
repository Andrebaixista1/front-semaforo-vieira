import React, { useEffect, useState, useCallback } from "react";
import DashboardSemaforo from "./DashboardSemaforo";
import DashboardRanking from "./DashboardRanking";
import { apiUrl } from "../utils/api";
import { FiMaximize2, FiMinimize2 } from "react-icons/fi";

const TEMPO_SEMAFORO = 30 * 1000;    // 30 segundos
const TEMPO_RANKING = 30 * 1000;     // 30 segundos

export default function PainelRotativo() {
  const [painelAtivo, setPainelAtivo] = useState(0); // 0 = semÃ¡foro, 1 = ranking
  const [rankingData, setRankingData] = useState([]);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // FunÃ§Ã£o para buscar dados do ranking
  const fetchRanking = useCallback(async () => {
    try {
  const res = await fetch(apiUrl("/api/ranking?empresa=VIEIRACRED"));
      
      if (!res.ok) {
        throw new Error(`Erro HTTP: ${res.status}`);
      }
      
      const data = await res.json();
      setRankingData(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Erro ao buscar ranking:", err);
    }
  }, []);

  // Controle da rotaÃ§Ã£o de painÃ©is
  useEffect(() => {
    const timer = setInterval(() => {
      setPainelAtivo(prev => (prev === 0 ? 1 : 0));
    }, painelAtivo === 0 ? TEMPO_SEMAFORO : TEMPO_RANKING);

    return () => clearInterval(timer);
  }, [painelAtivo]);

  // Busca inicial e configuraÃ§Ã£o de intervalo para atualizaÃ§Ã£o
  useEffect(() => {
    fetchRanking();
    const interval = setInterval(fetchRanking, 5 * 60 * 1000); // 5 minutos
    return () => clearInterval(interval);
  }, [fetchRanking]);

  // FunÃ§Ãµes para controle de tela cheia
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error(`Erro ao tentar entrar em tela cheia: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }, []);

  // Monitorar mudanÃ§as de tela cheia
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  return (
    <div className="relative w-full min-h-screen">
      {/* BotÃ£o de tela cheia */}
      <button 
        onClick={toggleFullscreen}
        className="fixed top-4 right-4 z-50 p-3 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors shadow-md"
        title={isFullscreen ? "Sair da tela cheia" : "Entrar em tela cheia"}
      >
        {isFullscreen ? <FiMinimize2 className="text-xl" /> : <FiMaximize2 className="text-xl" />}
      </button>

      {/* PainÃ©is */}
      <div className={`${painelAtivo === 0 ? 'block' : 'hidden'}`}>
        <DashboardSemaforo />
      </div>
      
      <div className={`${painelAtivo === 1 ? 'block' : 'hidden'}`}>
        <DashboardRanking rankingData={rankingData} />
      </div>
    </div>
  );
}




