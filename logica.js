/*
 * Reglas del recorrido del guardia. Este mismo archivo corre en el celular y en
 * Google Apps Script (ahí se pega como logica.gs): mantener una sola versión.
 *
 * Qué es una ronda: empieza con la primera marca y termina al pasar por todos
 * los puntos activos. Si pasan más de "intervalo + tolerancia" desde su inicio
 * sin completarse, se cierra como incompleta y la marca siguiente abre otra.
 * Así, una ronda que cruza una hora en punto no se parte en dos.
 */
const Recorrido = (() => {
  const MIN = 60000;
  const DIA_MIN = 1440;
  // Argentina es UTC-3 todo el año. Fijarlo evita depender de la zona del equipo.
  const DESFASE_ARG_MIN = -180;
  const MAX_DESFASE_RELOJ_MIN = 5;

  const CONFIG_INICIAL = {
    inicioTurno: '22:00',
    finTurno: '06:00',
    intervaloHoras: 2,
    toleranciaMin: 30,
    duracionMinimaMin: 5,
    guardias: [],
  };

  const dos = (n) => String(n).padStart(2, '0');
  const horaAMin = (txt) => {
    const [h, m] = String(txt).split(':').map(Number);
    return h * 60 + m;
  };
  const relojLocal = (ts) => new Date(ts + DESFASE_ARG_MIN * MIN);
  const fechaTxt = (ts) => {
    const d = relojLocal(ts);
    return `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}`;
  };
  const horaTxt = (ts) => {
    const d = relojLocal(ts);
    return `${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}`;
  };
  const fechaHoraTxt = (ts) => {
    const d = relojLocal(ts);
    return `${fechaTxt(ts)} ${horaTxt(ts)}:${dos(d.getUTCSeconds())}`;
  };
  const duracionTurnoMin = (cfg) => {
    const dur = (horaAMin(cfg.finTurno) - horaAMin(cfg.inicioTurno) + DIA_MIN) % DIA_MIN;
    return dur === 0 ? DIA_MIN : dur;
  };
  const limiteRondaMs = (cfg) => (cfg.intervaloHoras * 60 + cfg.toleranciaMin) * MIN;
  const rondasEsperadas = (cfg) => Math.ceil(duracionTurnoMin(cfg) / (cfg.intervaloHoras * 60));

  /** Noche a la que pertenece una hora. La noche lleva la fecha en que arranca el turno. */
  function ubicar(ts, cfg) {
    const d = relojLocal(ts);
    const minutos = d.getUTCHours() * 60 + d.getUTCMinutes();
    const desdeInicio = (minutos - horaAMin(cfg.inicioTurno) + DIA_MIN) % DIA_MIN;
    const noche = fechaTxt(ts - desdeInicio * MIN);
    return { noche, enTurno: desdeInicio < duracionTurnoMin(cfg) };
  }

  function limitesNoche(noche, cfg) {
    const inicioTs = Date.parse(`${noche}T00:00:00.000Z`) + (horaAMin(cfg.inicioTurno) - DESFASE_ARG_MIN) * MIN;
    return { inicioTs, finTs: inicioTs + duracionTurnoMin(cfg) * MIN };
  }

  function rondaNueva(n, inicio) {
    return { n, inicio, fin: inicio, marcados: {} };
  }

  function cerrarRonda(ronda, puntos, cfg, anteriorTs) {
    const faltan = puntos.filter((p) => !(p.uid in ronda.marcados)).map((p) => p.nombre);
    const completa = faltan.length === 0;
    const duracionMin = Math.round((ronda.fin - ronda.inicio) / MIN);
    return {
      ...ronda,
      faltan,
      completa,
      duracionMin,
      rapida: completa && puntos.length > 1 && duracionMin < cfg.duracionMinimaMin,
      tarde: ronda.inicio - anteriorTs > limiteRondaMs(cfg),
    };
  }

  /** Arma las rondas de una noche. Usa sólo marcas de puntos activos dentro del turno. */
  function armarRondas(marcas, puntos, cfg, inicioTurnoTs) {
    const activos = new Set(puntos.map((p) => p.uid));
    const ordenadas = marcas.filter((m) => activos.has(m.uid)).sort((a, b) => a.ts - b.ts);
    const rondas = [];
    let abierta = null;
    let anteriorTs = inicioTurnoTs;
    const cerrar = () => {
      rondas.push(cerrarRonda(abierta, puntos, cfg, anteriorTs));
      anteriorTs = abierta.inicio;
      abierta = null;
    };
    for (const m of ordenadas) {
      if (abierta && m.ts - abierta.inicio > limiteRondaMs(cfg)) cerrar();
      if (!abierta) abierta = rondaNueva(rondas.length + 1, m.ts);
      if (!(m.uid in abierta.marcados)) {
        abierta.marcados[m.uid] = m.ts;
        abierta.fin = m.ts;
      }
      if (Object.keys(abierta.marcados).length === puntos.length) cerrar();
    }
    if (abierta) cerrar();
    return rondas;
  }

  /** Detecta si el reloj fue para atrás entre marcas consecutivas del mismo celular. */
  function relojRetrocedio(marcas) {
    const porOrden = marcas.filter((m) => m.seq != null).sort((a, b) => a.seq - b.seq);
    return porOrden.some((m, i) => i > 0 && m.ts < porOrden[i - 1].ts);
  }

  /** Corrige la hora de una marca con la diferencia entre el reloj del celular y el de Google. */
  function corregirHora(marca, relojCelular, relojServidor) {
    const desfaseMs = relojServidor - relojCelular;
    const desfaseMin = Math.round(desfaseMs / MIN);
    const ts = marca.ts + desfaseMs;
    return {
      ts,
      desfaseMin,
      relojAlterado: Math.abs(desfaseMin) > MAX_DESFASE_RELOJ_MIN || ts > relojServidor + MIN,
    };
  }

  /** Resultado de una noche para las hojas "Noches" y "Rondas". */
  function resumenNoche(marcas, puntos, cfg, noche, ahora) {
    const { inicioTs, finTs } = limitesNoche(noche, cfg);
    const delTurno = marcas.filter((m) => m.ts >= inicioTs && m.ts < finTs);
    const rondas = armarRondas(delTurno, puntos, cfg, inicioTs);
    const hechas = rondas.filter((r) => r.completa).length;
    const incompletas = rondas.length - hechas;
    const esperadas = rondasEsperadas(cfg);
    const enCurso = ahora < finTs;
    const alertas = [];
    if (rondas.some((r) => r.rapida)) alertas.push('Ronda demasiado rápida');
    if (rondas.some((r) => r.tarde)) alertas.push('Ronda fuera de tiempo');
    if (marcas.some((m) => m.relojAlterado) || relojRetrocedio(delTurno)) {
      alertas.push('Reloj del celular alterado');
    }
    let estado;
    if (enCurso) estado = 'En curso';
    else if (!delTurno.length) estado = 'Sin marcas';
    else if (hechas >= esperadas && !alertas.length) estado = 'Cumplida';
    else estado = 'Revisar';
    return {
      noche, inicioTs, finTs, rondas, hechas, incompletas, esperadas, alertas, estado,
      marcas: delTurno.length,
      fueraDeTurno: marcas.length - delTurno.length,
    };
  }

  /** Lo que ve el guardia: la ronda actual y qué puntos le quedan. */
  function estadoActual(marcas, puntos, cfg, ahora) {
    const { noche, enTurno } = ubicar(ahora, cfg);
    const { inicioTs, finTs } = limitesNoche(noche, cfg);
    const delTurno = marcas.filter((m) => m.ts >= inicioTs && m.ts < finTs);
    const rondas = armarRondas(delTurno, puntos, cfg, inicioTs);
    const ultima = rondas[rondas.length - 1];
    const sigueAbierta = ultima && !ultima.completa && ahora - ultima.inicio <= limiteRondaMs(cfg);
    const actual = sigueAbierta ? ultima : null;
    const intervaloMs = cfg.intervaloHoras * 60 * MIN;
    const completa = Boolean(ultima && ultima.completa && ahora - ultima.inicio <= intervaloMs);
    let venceTs;
    if (actual) venceTs = actual.inicio + limiteRondaMs(cfg);
    else if (ultima) venceTs = ultima.inicio + intervaloMs;
    else venceTs = inicioTs + intervaloMs;
    const marcados = actual ? actual.marcados : completa ? ultima.marcados : {};
    return {
      noche,
      enTurno,
      ronda: actual || completa ? ultima.n : rondas.length + 1,
      completa,
      hechas: rondas.filter((r) => r.completa).length,
      esperadas: rondasEsperadas(cfg),
      venceTs: Math.min(venceTs, finTs),
      puntos: puntos.map((p) => ({ ...p, ts: marcados[p.uid] ?? null })),
    };
  }

  return {
    CONFIG_INICIAL, fechaTxt, horaTxt, fechaHoraTxt, rondasEsperadas, ubicar, limitesNoche,
    armarRondas, relojRetrocedio, corregirHora, resumenNoche, estadoActual,
  };
})();

if (typeof module !== 'undefined') module.exports = Recorrido;
