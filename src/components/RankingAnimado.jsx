import React, { useEffect, useState } from "react";

const userDefault = "/user-default.png"; // Ajuste o path conforme seu projeto

const renderPosicao = (idx) => {
  const style = { width: 52, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  if (idx === 0) return <div style={style}><span style={{ fontSize: 28, marginRight: 2 }}>🥇</span></div>;
  if (idx === 1) return <div style={style}><span style={{ fontSize: 26, marginRight: 2 }}>🥈</span></div>;
  if (idx === 2) return <div style={style}><span style={{ fontSize: 26, marginRight: 2 }}>🥉</span></div>;
  return <div style={{ ...style, fontWeight: 900, color: "#0583ea", fontSize: 28 }}>{idx + 1}</div>;
};

const styles = {
  page: {
    background: '#f8f9fa',
    minHeight: '100vh',
    width: '100%',
    padding: 0,
  },
  listContainer: {
    width: '100%',
    maxWidth: 940,
    paddingBottom: 32,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center'
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    alignItems: 'center',
    width: '100%',
  },
  item: {
    display: 'grid',
    gridTemplateColumns: '52px 90px 1fr 210px',
    alignItems: 'center',
    background: '#f3f6fa',
    borderRadius: '18px',
    boxShadow: '0 2px 10px #0001',
    padding: '14px 0 14px 0',
    minHeight: '110px',
    border: '2px solid #e0e4ea',
    fontFamily: 'Poppins, Arial, sans-serif',
    width: '100%',
    maxWidth: 900,
    boxSizing: 'border-box',
    transition: 'box-shadow .2s, transform .4s cubic-bezier(.19,1,.22,1)',
  },
  itemHighlight: {
    transform: "scale(1.07)",
    zIndex: 3,
    boxShadow: "0 8px 44px #1db21966, 0 2px 18px #0001",
    borderColor: "#1db219",
  },
  photo: {
    width: '74px',
    height: '74px',
    borderRadius: '50%',
    overflow: 'hidden',
    border: '3px solid #0583ea',
    background: '#d7e5fc',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto',
    flexShrink: 0,
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
    paddingLeft: 12,
    paddingRight: 12,
  },
  nome: {
    fontWeight: 900,
    fontSize: '1.23rem',
    color: '#1a1a1a',
    marginBottom: 3,
    lineHeight: 1.1,
    minWidth: 0,
    wordBreak: 'break-word',
    overflowWrap: 'break-word'
  },
  equipe: {
    color: '#626262',
    fontWeight: 500,
    fontSize: '0.98rem',
    lineHeight: 1.07,
  },
  valor: {
    color: '#1db219',
    fontWeight: 900,
    fontSize: '1.36rem',
    textAlign: 'right',
    lineHeight: 1.13,
    whiteSpace: 'nowrap',
    paddingRight: 12,
    display: 'block'
  },
};

const RankingAnimado = ({
  rankingData = [],
  tempoDestaque = 10000, // tempo em ms (10s por padrão)
  onFinish = () => {}
}) => {
  const [destaqueIdx, setDestaqueIdx] = useState(null);
  const [fase, setFase] = useState("lista"); // "lista" | "animar"

  useEffect(() => {
    if (rankingData.length > 0) {
      setFase("lista");
      setDestaqueIdx(null);

      // Mostra o ranking normal por 3s, depois anima 1 a 1
      const t1 = setTimeout(() => {
        setFase("animar");
        setDestaqueIdx(0);
      }, 3000);

      // Depois de todos animados, finaliza
      const t2 = setTimeout(() => {
        onFinish();
      }, 3000 + tempoDestaque * rankingData.length);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [rankingData, tempoDestaque, onFinish]);

  useEffect(() => {
    if (fase === "animar" && destaqueIdx !== null && destaqueIdx < rankingData.length - 1) {
      const t = setTimeout(() => {
        setDestaqueIdx(destaqueIdx + 1);
      }, tempoDestaque);
      return () => clearTimeout(t);
    }
  }, [fase, destaqueIdx, rankingData.length, tempoDestaque]);

  if (!rankingData || !rankingData.length) {
    return <div style={{textAlign:"center", fontSize:22}}>Sem dados do ranking.</div>;
  }

  return (
    <div style={styles.page}>
      <img src="/vieiracred.png" alt="Vieiracred" style={{ width: 150, margin: "32px auto", display: "block" }} />
      <div style={styles.listContainer}>
        <div style={styles.list}>
          {rankingData.map((vendedor, idx) => {
            let itemStyle = { ...styles.item };
            if (fase === "animar" && destaqueIdx === idx) {
              itemStyle = { ...itemStyle, ...styles.itemHighlight };
            }
            return (
              <div
                key={vendedor.vendedor_id || vendedor.usuario_id || vendedor.id || idx}
                style={itemStyle}
              >
                {renderPosicao(idx)}
                <div style={styles.photo}>
                  <img
                    src={vendedor.foto && vendedor.foto.trim() !== "" ? vendedor.foto : userDefault}
                    alt={vendedor.nome}
                    style={styles.img}
                  />
                </div>
                <div style={styles.infoCol}>
                  <span style={styles.nome}>{vendedor.nome}</span>
                  <span style={styles.equipe}><b>Equipe:</b> {vendedor.equipe}</span>
                </div>
                <span style={styles.valor}>
                  <b>
                    R$
                    {Number(vendedor.valorVendido).toLocaleString('pt-BR', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}
                  </b>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default RankingAnimado;
