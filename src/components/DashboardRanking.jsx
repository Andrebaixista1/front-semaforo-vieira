import React, { useState, useEffect } from 'react';
import { apiUrl } from '../utils/api';

// Posição SEM emojis (número grande e consistente)
const renderPosicao = (idx) => {
  const style = {
    width: 64,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 38,
    fontWeight: 900,
    color: '#0583ea'
  };
  return <div style={style}>{idx + 1}</div>;
};

const formatCurrency = (value) => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2
  }).format(value);
};

const styles = {
  page: {
    background: 'linear-gradient(135deg, #0d0f17 0%, #141a28 100%)',
    minHeight: '100vh',
    width: '100%',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflow: 'hidden',
    fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  },
  logo: {
    width: 220,
    margin: '32px auto 8px',
    display: 'block',
    zIndex: 10,
  },
  titleWrap: {
    textAlign: 'center',
    marginBottom: 24,
    padding: '0 20px',
  },
  title: {
    fontSize: '2.2rem',
    fontWeight: 900,
    color: '#ffffff',
    letterSpacing: 0.3,
    textShadow: '0 2px 6px rgba(0,0,0,0.5)',
  },
  contentContainer: {
    width: '100%',
    maxWidth: 1040,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 24px 48px',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    alignItems: 'center',
    width: '100%',
    maxWidth: 1020,
  },
  item: {
    display: 'grid',
    gridTemplateColumns: '64px 110px 1fr 260px',
    alignItems: 'center',
    background: 'rgba(30, 35, 50, 0.85)',
    borderRadius: '22px',
    boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
    padding: '18px 0',
    minHeight: '140px',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    fontFamily: 'Poppins, Arial, sans-serif',
    width: '100%',
    boxSizing: 'border-box',
    transition: 'transform .15s ease, box-shadow .15s ease',
  },
  top5Item: {
    background: 'linear-gradient(90deg, #2a2a2a 0%, #0583ea 100%)',
    border: '3px solid #0583ea',
    boxShadow: '0 10px 34px rgba(5, 131, 234, 0.35), 0 2px 10px rgba(0,0,0,0.25)',
    minHeight: 160,
    zIndex: 1,
  },
  photo: {
    width: '96px',
    height: '96px',
    borderRadius: '50%',
    overflow: 'hidden',
    border: '4px solid #0583ea',
    background: '#2a3a5a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto',
    flexShrink: 0,
    boxShadow: '0 0 14px rgba(5,131,234,0.35)',
  },
  img: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    borderRadius: '50%',
    background: '#fff',
    display: 'block',
  },
  infoCol: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minWidth: 0,
    wordBreak: 'break-word',
    paddingLeft: 16,
    paddingRight: 16,
  },
  nome: {
    fontWeight: 900,
    fontSize: '1.6rem',
    color: '#ffffff',
    marginBottom: 6,
    lineHeight: 1.15,
    minWidth: 0,
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
    textShadow: '0 2px 6px rgba(0,0,0,0.6)',
  },
  equipe: {
    color: '#ffffff',
    opacity: 0.95,
    fontWeight: 700,
    fontSize: '1.15rem',
    lineHeight: 1.1,
    textShadow: '0 2px 4px rgba(0,0,0,0.45)',
  },
  valor: {
    color: '#FFFFFF',
    fontWeight: 900,
    fontSize: '1.9rem',
    textAlign: 'right',
    lineHeight: 1.15,
    whiteSpace: 'nowrap',
    paddingRight: 16,
    display: 'block',
    textShadow: '0 2px 6px rgba(0,0,0,0.6)',
    filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.9))',
  },
  loadingContainer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },
  loadingText: {
    fontSize: 22,
    color: '#aaa',
    textAlign: 'center',
  },
};

const userDefault = "/user-default.png";

const RankingList = ({ data }) => (
  <div style={styles.list}>
    {data.slice(0, 5).map((vendedor, idx) => {
      const itemStyle = { ...styles.item, ...styles.top5Item };
      const photoStyle = { ...styles.photo };

      return (
        <div
          key={vendedor.vendedor_id || vendedor.usuario_id || vendedor.id || idx}
          style={itemStyle}
        >
          {renderPosicao(idx)}
          <div style={photoStyle}>
            <img
              src={vendedor.foto && vendedor.foto.trim() !== "" ? vendedor.foto : userDefault}
              alt={vendedor.nome}
              style={styles.img}
              onError={(e) => { e.currentTarget.src = userDefault; }}
            />
          </div>
          <div style={styles.infoCol}>
            <span style={styles.nome}>{vendedor.nome}</span>
            <span style={styles.equipe}><b>Equipe:</b> {vendedor.equipe}</span>
          </div>
          <span style={styles.valor}>
            <b>{formatCurrency(vendedor.valorVendido)}</b>
          </span>
        </div>
      );
    })}
  </div>
);

const Ranking = () => {
  const [rankingData, setRankingData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(apiUrl("/api/ranking?empresa=VIEIRACRED"));
        if (!res.ok) throw new Error(`Erro HTTP: ${res.status}`);
        const data = await res.json();
        const rankingArray = Array.isArray(data) ? data : (Array.isArray(data.ranking) ? data.ranking : []);
        const formatted = rankingArray.map(item => ({
          ...item,
          valorVendido:
            typeof item.valorVendido === 'string'
              ? parseFloat(item.valorVendido.replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0
              : (item.valorVendido || 0)
        }));
        formatted.sort((a, b) => b.valorVendido - a.valorVendido);
        setRankingData(formatted);
      } catch (err) {
        console.error("Erro ao buscar ranking:", err);
        setError(err.message);
        setRankingData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={styles.page}>
      <img src="/vieiracred-branco.png" alt="Vieiracred" style={styles.logo} />
      <div style={styles.titleWrap}>
        <h1 style={styles.title}>Ranking de Vendas Diário</h1>
      </div>

      <div style={styles.contentContainer}>
        {loading ? (
          <div style={styles.loadingContainer}>
            <span style={styles.loadingText}>Carregando ranking...</span>
          </div>
        ) : error ? (
          <div style={styles.loadingContainer}>
            <span style={styles.loadingText}>Erro: {error}</span>
          </div>
        ) : rankingData.length > 0 ? (
          <RankingList data={rankingData} />
        ) : (
          <div style={styles.loadingContainer}>
            <span style={styles.loadingText}>Nenhum dado disponível</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default Ranking;
