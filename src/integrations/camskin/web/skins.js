// Skins du POC : dessin 2D procedural ancre sur les landmarks du visage.
// Repere local : origine = milieu des yeux, x le long de la ligne des yeux,
// y vers le bas, unite `u` = distance entre les yeux. La rotation (roll) est appliquee.
// Yaw/pitch ne sont pas geres ici (le POC valide le suivi et la sortie, pas le rendu final).

const TAU = Math.PI * 2;

function circle(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = r * 0.12;
    ctx.stroke();
  }
}

function polygon(ctx, pts, fill) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// Grenouille : skin 3D (masque de tete complet), genere par scripts/blender/make_frog.py.
const frog = {
  label: 'Grenouille',
  model: '/models/skins/frog/manifest.json',
  body: true,
};

const cat = {
  label: 'Chat',
  draw(ctx, f) {
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);
    const u = f.u;
    for (const side of [-1, 1]) {
      polygon(ctx, [[side * 0.35 * u, -0.95 * u], [side * 1.25 * u, -1.0 * u], [side * 1.05 * u, -2.0 * u]], '#3b3b46');
      polygon(ctx, [[side * 0.55 * u, -1.0 * u], [side * 1.05 * u, -1.02 * u], [side * 0.97 * u, -1.6 * u]], '#f4a6b8');
    }
    ctx.restore();

    // Nez + moustaches ancres sur le bout du nez reel.
    ctx.save();
    ctx.translate(f.nose.x, f.nose.y);
    ctx.rotate(f.angle);
    polygon(ctx, [[-f.u * 0.12, -f.u * 0.05], [f.u * 0.12, -f.u * 0.05], [0, f.u * 0.11]], '#f4a6b8');
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, f.u * 0.025);
    for (const side of [-1, 1]) {
      for (const dy of [-0.08, 0.04, 0.16]) {
        ctx.beginPath();
        ctx.moveTo(side * f.u * 0.45, dy * f.u);
        ctx.lineTo(side * f.u * 1.2, (dy * 2.2 - 0.05) * f.u);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};

const flower = {
  label: 'Couronne de fleurs',
  draw(ctx, f) {
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);
    const u = f.u;
    const colors = ['#ff7eb6', '#ffd166', '#b388ff', '#ff8c69', '#7ee0a1'];
    const count = 9;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const a = Math.PI * (1.08 + t * 0.84); // arc au-dessus du front
      const x = Math.cos(a) * 1.35 * u;
      const y = -1.1 * u + Math.sin(a) * 0.85 * u;
      const r = (0.17 + 0.05 * Math.sin(t * Math.PI)) * u;
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * TAU + t;
        circle(ctx, x + Math.cos(pa) * r, y + Math.sin(pa) * r, r * 0.8, colors[i % colors.length]);
      }
      circle(ctx, x, y, r * 0.55, '#fff3b0');
    }
    ctx.restore();
  },
};

// Skin 3D : pas de `draw`, un manifeste (voir skin-manifest.js) decrit le modele glTF et son
// ancrage. Rendu par skin3d.js. Modele provisoire, a remplacer par le vrai dragon.
const dragon = {
  label: 'Dragon',
  model: '/models/skins/dragon/manifest.json',
  // Le manifeste decrit aussi un corps : le suivi calcule alors la pose du corps (epaules, bras).
  body: true,
};

export const SKINS = { frog, cat, flower, dragon };

/** Vrai si le skin a un corps : le suivi doit calculer la pose du corps en plus du visage. */
export function hasBody(skin) {
  return skin?.body === true;
}

/** Vrai si le skin est rendu en 3D (manifeste + modele glTF) plutot qu'en dessin 2D. */
export function is3D(skin) {
  return typeof skin?.model === 'string';
}
