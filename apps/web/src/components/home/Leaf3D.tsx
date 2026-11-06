'use client';

import { useEffect, useRef, useState } from 'react';
import type * as ThreeModule from 'three';

import { LEAF_POINTS } from '@/components/ui/Icon';

type Three = typeof ThreeModule;

/**
 * The prototype's extruded 3D maple leaf: it follows the pointer and can be
 * dragged to spin. three.js is loaded only after hydration, and nothing loads
 * for reduced-motion users or without WebGL. The flat SVG leaf shows until
 * this mounts (`.bhero:has(.leaf3d.on) .leaf` in globals.css). Phones get
 * neither leaf, so three.js isn't downloaded there either.
 */
export function Leaf3D() {
  const host = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 760px)').matches) return;
    let unmount: (() => void) | undefined;
    let cancelled = false;
    void import('three').then((THREE) => {
      if (cancelled || !host.current) return;
      unmount = mount(THREE, host.current);
      if (unmount) setOn(true);
    });
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, []);

  return <div ref={host} className={on ? 'leaf3d on' : 'leaf3d'} aria-hidden="true" />;
}

function mount(THREE: Three, host: HTMLDivElement): (() => void) | undefined {
  let renderer: ThreeModule.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch {
    return undefined; // No WebGL: keep the flat leaf.
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 9);

  const shape = new THREE.Shape();
  LEAF_POINTS.forEach(([px, py], i) => {
    const x = (px - 50) / 25;
    const y = -(py - 50) / 25;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.045, bevelSegments: 3, curveSegments: 4 });
  geometry.center();
  const material = new THREE.MeshStandardMaterial({ color: 0xe31e24, roughness: 0.42, metalness: 0.08 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  // The prototype ran three r152 with legacy lighting; ×π reproduces it under physical units (r155+).
  scene.add(new THREE.AmbientLight(0xffffff, 0.55 * Math.PI));
  const key = new THREE.DirectionalLight(0xffffff, 1.05 * Math.PI);
  key.position.set(3, 4, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc0ea, 0.5 * Math.PI);
  rim.position.set(-4, -2, 3);
  scene.add(rim);

  const fit = () => {
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 300;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    mesh.scale.setScalar(Math.min(0.95, Math.max(0.5, Math.min(w, h) / 420)));
  };
  fit();

  // Tilt toward the pointer; dragging adds spin.
  let tiltX = 0;
  let tiltY = 0;
  let spin = 0;
  let drag: { x: number; y: number } | null = null;
  const start = performance.now();
  const canvas = renderer.domElement;
  const onDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (drag) {
      spin += (e.clientX - drag.x) * 0.012;
      tiltX += (e.clientY - drag.y) * 0.006;
      drag = { x: e.clientX, y: e.clientY };
    } else {
      tiltY = ((e.clientX / window.innerWidth) * 2 - 1) * 0.55;
      tiltX = -((e.clientY / window.innerHeight) * 2 - 1) * 0.3;
    }
  };
  const onUp = () => {
    drag = null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  const resize = new ResizeObserver(fit);
  resize.observe(host);

  let frame = 0;
  const loop = () => {
    const t = (performance.now() - start) / 1000;
    mesh.rotation.y += (tiltY + spin - mesh.rotation.y) * 0.08;
    mesh.rotation.x += (tiltX + Math.sin(t * 0.8) * 0.04 - mesh.rotation.x) * 0.08;
    mesh.position.y = Math.sin(t * 1.1) * 0.08;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(loop);
  };
  loop();

  return () => {
    cancelAnimationFrame(frame);
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    resize.disconnect();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    canvas.remove();
  };
}
