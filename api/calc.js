// calc.js — Funciones de cálculo de precios, IVA, márgenes y comisiones
// Snapshot inmutable: todo se graba al momento de la venta, no se recalcula después

module.exports = {
  /**
   * Obtiene la comisión aplicable para una venta (cascada de prioridad)
   * 1. Override por producto → 2. Override por categoría → 3. Default de vendedora
   */
  getComision(producto, familia, comisionVendedoraDefault) {
    // Paso 1: ¿Hay override por producto?
    if (producto?.comision_vendedora_override != null) {
      return parseFloat(producto.comision_vendedora_override);
    }
    // Paso 2: ¿Hay override por categoría? (se pasa como parámetro desde arriba)
    if (producto?.comision_categoria_override != null) {
      return parseFloat(producto.comision_categoria_override);
    }
    // Paso 3: Default de vendedora
    return parseFloat(comisionVendedoraDefault) || 0;
  },

  /**
   * Calcula todos los valores de una línea de venta (cantidad × valores unitarios)
   * Devuelve snapshot con: base_imponible, monto_iva, margen_bruto, comision_monto, utilidad_vitrina
   *
   * @param {object} params - { cantidad, costo_unitario, precio_pvp, iva_porcentaje, comision_porcentaje }
   * @returns {object} snapshot con todos los cálculos
   */
  calcularLinea({
    cantidad = 1,
    costo_unitario = 0,
    precio_pvp = 0,
    iva_porcentaje = 19,
    comision_porcentaje = 0
  }) {
    // Validar que los valores sean números
    cantidad = parseFloat(cantidad) || 0;
    costo_unitario = parseFloat(costo_unitario) || 0;
    precio_pvp = parseFloat(precio_pvp) || 0;
    iva_porcentaje = parseFloat(iva_porcentaje) || 0;
    comision_porcentaje = parseFloat(comision_porcentaje) || 0;

    // Fórmulas críticas (orden importa):
    // 1. Base imponible (precio sin IVA)
    const factor_iva = 1 + (iva_porcentaje / 100);
    const base_imponible_unitario = precio_pvp / factor_iva;

    // 2. Monto de IVA (por unidad)
    const iva_unitario = base_imponible_unitario * (iva_porcentaje / 100);

    // 3. Margen bruto (ganancia antes de comisión, por unidad)
    const margen_bruto_unitario = base_imponible_unitario - costo_unitario;

    // 4. Comisión vendedora (sobre margen bruto, por unidad)
    const comision_unitario = margen_bruto_unitario * (comision_porcentaje / 100);

    // 5. Utilidad de La Vitrina (después de comisión, por unidad)
    const utilidad_vitrina_unitario = margen_bruto_unitario - comision_unitario;

    // Multiplicar por cantidad (total línea)
    return {
      cantidad: Math.round(cantidad * 100) / 100,

      // Valores unitarios (para referencia y auditoría)
      costo_unitario: Math.round(costo_unitario * 100) / 100,
      precio_pvp_unitario: Math.round(precio_pvp * 100) / 100,
      iva_porcentaje,
      comision_porcentaje,

      // Cálculos por línea (cantidad × unitario)
      base_imponible: Math.round(base_imponible_unitario * cantidad * 100) / 100,
      monto_iva: Math.round(iva_unitario * cantidad * 100) / 100,
      margen_bruto: Math.round(margen_bruto_unitario * cantidad * 100) / 100,
      comision_monto: Math.round(comision_unitario * cantidad * 100) / 100,
      utilidad_vitrina: Math.round(utilidad_vitrina_unitario * cantidad * 100) / 100,

      // Total a cobrar (incluye IVA)
      total_linea: Math.round(precio_pvp * cantidad * 100) / 100
    };
  },

  /**
   * Suma múltiples líneas y devuelve totales consolidados
   */
  sumarLineas(lineas) {
    const suma = {
      cantidad: 0,
      base_imponible: 0,
      monto_iva: 0,
      margen_bruto: 0,
      comision_monto: 0,
      utilidad_vitrina: 0,
      total_linea: 0
    };

    lineas.forEach(linea => {
      suma.cantidad += linea.cantidad || 0;
      suma.base_imponible += linea.base_imponible || 0;
      suma.monto_iva += linea.monto_iva || 0;
      suma.margen_bruto += linea.margen_bruto || 0;
      suma.comision_monto += linea.comision_monto || 0;
      suma.utilidad_vitrina += linea.utilidad_vitrina || 0;
      suma.total_linea += linea.total_linea || 0;
    });

    // Redondear
    Object.keys(suma).forEach(k => {
      suma[k] = Math.round(suma[k] * 100) / 100;
    });

    return suma;
  }
};
