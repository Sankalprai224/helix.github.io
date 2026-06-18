class LineChart {
  constructor(containerId, options) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    this.options = options;
    this.svgNS = "http://www.w3.org/2000/svg";
    this.render();
    window.addEventListener('resize', () => this.render());
  }

  render() {
    this.container.innerHTML = '';
    const width = this.container.clientWidth;
    const height = this.options.height || 350;
    const padding = { top: 30, right: 40, bottom: 65, left: 120 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const svg = document.createElementNS(this.svgNS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.style.overflow = 'visible';

    // Find min/max for scaling
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    this.options.datasets.forEach(dataset => {
      dataset.data.forEach(point => {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      });
    });

    if (this.options.yMin !== undefined) minY = this.options.yMin;
    if (this.options.yMax !== undefined) maxY = this.options.yMax;
    
    // Add padding to maxY so highest point isn't touching the top
    maxY = maxY + (maxY - minY) * 0.1;
    if (maxY === minY) maxY = minY + 1;

    const scaleX = (x) => padding.left + ((x - minX) / (maxX - minX)) * chartWidth;
    const scaleY = (y) => height - padding.bottom - ((y - minY) / (maxY - minY)) * chartHeight;

    // Draw Axes
    const axesGroup = document.createElementNS(this.svgNS, 'g');
    axesGroup.setAttribute('class', 'chart-axes');

    // Y Axis
    const yAxis = document.createElementNS(this.svgNS, 'line');
    yAxis.setAttribute('x1', padding.left);
    yAxis.setAttribute('y1', padding.top);
    yAxis.setAttribute('x2', padding.left);
    yAxis.setAttribute('y2', height - padding.bottom);
    axesGroup.appendChild(yAxis);

    // X Axis
    const xAxis = document.createElementNS(this.svgNS, 'line');
    xAxis.setAttribute('x1', padding.left);
    xAxis.setAttribute('y1', height - padding.bottom);
    xAxis.setAttribute('x2', width - padding.right);
    xAxis.setAttribute('y2', height - padding.bottom);
    axesGroup.appendChild(xAxis);

    // Grid lines and labels (Y)
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const val = minY + (maxY - minY) * (i / ySteps);
      const y = scaleY(val);
      
      const gridLine = document.createElementNS(this.svgNS, 'line');
      gridLine.setAttribute('x1', padding.left);
      gridLine.setAttribute('y1', y);
      gridLine.setAttribute('x2', width - padding.right);
      gridLine.setAttribute('y2', y);
      gridLine.setAttribute('class', 'chart-grid');
      axesGroup.appendChild(gridLine);

      const label = document.createElementNS(this.svgNS, 'text');
      label.setAttribute('x', padding.left - 12);
      label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('class', 'chart-label');
      label.textContent = val.toFixed(this.options.yDecimals || 1) + (this.options.yUnit || '');
      axesGroup.appendChild(label);
    }

    // X labels
    const xSteps = this.options.xLabels ? this.options.xLabels.length - 1 : 5;
    for (let i = 0; i <= xSteps; i++) {
      const val = minX + (maxX - minX) * (i / xSteps);
      const x = scaleX(val);
      
      const label = document.createElementNS(this.svgNS, 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', height - padding.bottom + 22);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'chart-label');
      label.textContent = this.options.xLabels ? this.options.xLabels[i] : Math.round(val);
      axesGroup.appendChild(label);
    }
    
    // X Axis title
    if (this.options.xAxisTitle) {
      const xTitle = document.createElementNS(this.svgNS, 'text');
      xTitle.setAttribute('x', padding.left + chartWidth / 2);
      xTitle.setAttribute('y', height - 12);
      xTitle.setAttribute('text-anchor', 'middle');
      xTitle.setAttribute('class', 'chart-axis-title');
      xTitle.textContent = this.options.xAxisTitle;
      axesGroup.appendChild(xTitle);
    }
    
    // Y Axis title
    if (this.options.yAxisTitle) {
      const yTitle = document.createElementNS(this.svgNS, 'text');
      yTitle.setAttribute('transform', `translate(25, ${padding.top + chartHeight/2}) rotate(-90)`);
      yTitle.setAttribute('text-anchor', 'middle');
      yTitle.setAttribute('class', 'chart-axis-title');
      yTitle.textContent = this.options.yAxisTitle;
      axesGroup.appendChild(yTitle);
    }

    svg.appendChild(axesGroup);

    // Draw lines
    const tooltipTarget = document.createElement('div');
    tooltipTarget.className = 'chart-tooltip';
    this.container.appendChild(tooltipTarget);

    this.options.datasets.forEach((dataset, index) => {
      // Curved path generation
      const path = document.createElementNS(this.svgNS, 'path');
      let d = '';
      
      if (dataset.data.length > 0) {
        d = `M ${scaleX(dataset.data[0].x)} ${scaleY(dataset.data[0].y)}`;
        // Simple smoothing using cubic bezier
        for (let i = 1; i < dataset.data.length; i++) {
          const p0 = dataset.data[i - 1];
          const p1 = dataset.data[i];
          const x0 = scaleX(p0.x);
          const y0 = scaleY(p0.y);
          const x1 = scaleX(p1.x);
          const y1 = scaleY(p1.y);
          
          const cpX1 = x0 + (x1 - x0) / 3;
          const cpY1 = y0;
          const cpX2 = x1 - (x1 - x0) / 3;
          const cpY2 = y1;
          
          d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${x1} ${y1}`;
        }
      }

      path.setAttribute('d', d);
      path.setAttribute('class', 'chart-line chart-line-anim');
      path.setAttribute('stroke', dataset.color || `hsl(${index * 137.5 % 360}, 70%, 50%)`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '3');
      
      // Animation hack
      path.setAttribute('stroke-dasharray', '2000');
      path.setAttribute('stroke-dashoffset', '2000');
      svg.appendChild(path);

      // Points for hover
      const pointsGroup = document.createElementNS(this.svgNS, 'g');
      dataset.data.forEach((point) => {
        const circle = document.createElementNS(this.svgNS, 'circle');
        const cx = scaleX(point.x);
        const cy = scaleY(point.y);
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', '6');
        circle.setAttribute('fill', 'var(--bg-color)');
        circle.setAttribute('stroke', dataset.color);
        circle.setAttribute('stroke-width', '2');
        circle.setAttribute('class', 'chart-point');
        
        // Tooltip logic
        const hitArea = document.createElementNS(this.svgNS, 'circle');
        hitArea.setAttribute('cx', cx);
        hitArea.setAttribute('cy', cy);
        hitArea.setAttribute('r', '15');
        hitArea.setAttribute('fill', 'transparent');
        hitArea.style.cursor = 'pointer';
        
        hitArea.addEventListener('mouseenter', (e) => {
          circle.setAttribute('r', '8');
          circle.setAttribute('fill', dataset.color);
          tooltipTarget.style.opacity = '1';
          tooltipTarget.innerHTML = `<strong>${dataset.label}</strong><br/>${this.options.xAxisTitle}: ${point.x}<br/>${this.options.yAxisTitle}: ${point.y}${this.options.yUnit||''}`;
          const rect = this.container.getBoundingClientRect();
          tooltipTarget.style.left = (e.clientX - rect.left + 15) + 'px';
          tooltipTarget.style.top = (e.clientY - rect.top - 45) + 'px';
        });
        hitArea.addEventListener('mouseleave', () => {
          circle.setAttribute('r', '6');
          circle.setAttribute('fill', 'var(--bg-color)');
          tooltipTarget.style.opacity = '0';
        });
        
        pointsGroup.appendChild(circle);
        pointsGroup.appendChild(hitArea);
      });
      svg.appendChild(pointsGroup);
      
      // Trigger animation frame hack
      requestAnimationFrame(() => {
        const len = path.getTotalLength();
        path.setAttribute('stroke-dasharray', len);
        path.style.transition = 'stroke-dashoffset 1.5s ease-in-out';
        path.setAttribute('stroke-dashoffset', '0');
      });
    });

    this.container.appendChild(svg);
    
    // Draw Header (Title & Legend)
    const header = document.createElement('div');
    header.className = 'chart-header';
    
    if (this.options.title) {
        const title = document.createElement('div');
        title.className = 'chart-title';
        title.textContent = this.options.title;
        header.appendChild(title);
    }
    
    if (this.options.showLegend !== false) {
      const legend = document.createElement('div');
      legend.className = 'chart-legend';
      this.options.datasets.forEach(dataset => {
        const item = document.createElement('div');
        item.className = 'chart-legend-item';
        item.innerHTML = `<span class="chart-legend-color" style="background:${dataset.color}"></span> ${dataset.label}`;
        legend.appendChild(item);
      });
      header.appendChild(legend);
    }
    
    this.container.insertBefore(header, this.container.firstChild);
  }
}

class BarChart {
  constructor(containerId, options) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    this.options = options;
    this.svgNS = "http://www.w3.org/2000/svg";
    this.render();
    window.addEventListener('resize', () => this.render());
  }

  render() {
    this.container.innerHTML = '';
    const width = this.container.clientWidth;
    // Extra top padding to ensure value labels never clip
    const padding = { top: 56, right: 30, bottom: 48, left: 30 };
    const chartHeight = 220;
    const height = chartHeight + padding.top + padding.bottom;

    const svg = document.createElementNS(this.svgNS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.overflow = 'hidden'; // never clip outside
    svg.style.display = 'block';

    const data = this.options.data;
    const n = data.length;

    // Find max value for scaling
    let maxVal = 0;
    data.forEach(item => { if (item.value > maxVal) maxVal = item.value; });

    // Minimum visible bar height so tiny bars are still visible
    const MIN_BAR_PX = 4;

    const chartAreaWidth = width - padding.left - padding.right;
    const totalBarWidth = chartAreaWidth * 0.55; // bars take 55% of area
    const barWidth = Math.min(120, totalBarWidth / n);
    const gap = (chartAreaWidth - barWidth * n) / (n + 1);

    const scaleY = (val) => {
      const ratio = maxVal > 0 ? val / maxVal : 0;
      return Math.max(MIN_BAR_PX, ratio * chartHeight);
    };

    const baselineY = padding.top + chartHeight;

    // Draw baseline
    const baseline = document.createElementNS(this.svgNS, 'line');
    baseline.setAttribute('x1', padding.left);
    baseline.setAttribute('y1', baselineY);
    baseline.setAttribute('x2', width - padding.right);
    baseline.setAttribute('y2', baselineY);
    baseline.setAttribute('stroke', 'var(--border-color)');
    baseline.setAttribute('stroke-width', '2');
    svg.appendChild(baseline);

    data.forEach((item, index) => {
      const barH = scaleY(item.value);
      const x = padding.left + gap + index * (barWidth + gap);
      const barTopY = baselineY - barH;

      // Bar group: rounded top only
      const g = document.createElementNS(this.svgNS, 'g');

      // Main bar (fully rounded, starts at 0 height)
      const rect = document.createElementNS(this.svgNS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', baselineY);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', 0);
      rect.setAttribute('rx', '6');
      rect.setAttribute('ry', '6');
      rect.setAttribute('fill', item.color || '#4caf50');
      g.appendChild(rect);

      // Square-off bottom corners overlay
      const squareBottom = document.createElementNS(this.svgNS, 'rect');
      squareBottom.setAttribute('x', x);
      squareBottom.setAttribute('y', baselineY - 8);
      squareBottom.setAttribute('width', barWidth);
      squareBottom.setAttribute('height', 8);
      squareBottom.setAttribute('fill', item.color || '#4caf50');
      squareBottom.style.opacity = '0';
      g.appendChild(squareBottom);

      svg.appendChild(g);

      // Value label — placed at final position immediately (stable, no animation)
      const valText = document.createElementNS(this.svgNS, 'text');
      valText.setAttribute('x', x + barWidth / 2);
      valText.setAttribute('y', barTopY - 10);
      valText.setAttribute('text-anchor', 'middle');
      valText.setAttribute('class', 'chart-label');
      valText.setAttribute('font-size', '0.95rem');
      valText.setAttribute('font-weight', 'bold');
      valText.setAttribute('fill', 'var(--text-color)');
      valText.style.opacity = '0';
      valText.textContent = item.valueDisplay || item.value;
      svg.appendChild(valText);

      // Bar label below baseline
      const label = document.createElementNS(this.svgNS, 'text');
      label.setAttribute('x', x + barWidth / 2);
      label.setAttribute('y', baselineY + 28);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'chart-label');
      label.setAttribute('font-weight', '600');
      label.textContent = item.label;
      svg.appendChild(label);

      // Animate bars growing up + fade in label
      requestAnimationFrame(() => {
        setTimeout(() => {
          rect.style.transition = 'y 0.9s cubic-bezier(0.16, 1, 0.3, 1), height 0.9s cubic-bezier(0.16, 1, 0.3, 1)';
          rect.setAttribute('y', barTopY);
          rect.setAttribute('height', barH);

          squareBottom.style.transition = 'opacity 0.3s ease 0.5s';
          squareBottom.style.opacity = '1';

          valText.style.transition = 'opacity 0.4s ease 0.7s';
          valText.style.opacity = '1';
        }, index * 100);
      });
    });

    this.container.appendChild(svg);
  }
}

window.LineChart = LineChart;
window.BarChart = BarChart;

/**
 * GroupedBarChart — clean reference-style grouped bars
 * Light background, legend at top, thin borders, matching the reference image aesthetic.
 */
class GroupedBarChart {
  constructor(containerId, options) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    this.options = options; // { title, yUnit, yAxisTitle, xAxisTitle, labels[], datasets[{label,color,values[]}] }
    this.svgNS = 'http://www.w3.org/2000/svg';
    this.render();
    window.addEventListener('resize', () => this.render());
  }

  render() {
    this.container.innerHTML = '';

    const isDark = document.documentElement.classList.contains('dark-mode') ||
      document.body.classList.contains('dark-mode') ||
      window.matchMedia('(prefers-color-scheme: dark)').matches;

    const bg       = isDark ? '#1a1a1a' : '#fafafa';
    const textCol  = isDark ? '#ccc'    : '#333';
    const gridCol  = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    const axisCol  = isDark ? 'rgba(255,255,255,0.2)'  : 'rgba(0,0,0,0.2)';

    const labels   = this.options.labels;
    const datasets = this.options.datasets;
    const n        = labels.length;
    const nSets    = datasets.length;

    // Find max value
    let maxVal = 0;
    datasets.forEach(ds => ds.values.forEach(v => { if (v > maxVal) maxVal = v; }));
    maxVal = maxVal * 1.2; // 20% headroom

    const containerW = this.container.clientWidth;
    const pad = { top: 60, right: 30, bottom: 55, left: 65 };
    const chartH = 260;
    const totalH  = chartH + pad.top + pad.bottom;
    const chartW  = containerW - pad.left - pad.right;

    const svg = document.createElementNS(this.svgNS, 'svg');
    svg.setAttribute('width', containerW);
    svg.setAttribute('height', totalH);
    svg.setAttribute('viewBox', `0 0 ${containerW} ${totalH}`);
    svg.style.display = 'block';
    svg.style.overflow = 'hidden';

    // Background
    const bgRect = document.createElementNS(this.svgNS, 'rect');
    bgRect.setAttribute('width', containerW);
    bgRect.setAttribute('height', totalH);
    bgRect.setAttribute('fill', bg);
    bgRect.setAttribute('rx', '10');
    svg.appendChild(bgRect);

    const scaleY = v => pad.top + chartH - (v / maxVal) * chartH;
    const baseY  = pad.top + chartH;

    // Grid lines (5)
    for (let i = 0; i <= 5; i++) {
      const v = (maxVal / 5) * i;
      const y = scaleY(v);
      const line = document.createElementNS(this.svgNS, 'line');
      line.setAttribute('x1', pad.left); line.setAttribute('x2', pad.left + chartW);
      line.setAttribute('y1', y);        line.setAttribute('y2', y);
      line.setAttribute('stroke', gridCol); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);

      // Y labels
      const lbl = document.createElementNS(this.svgNS, 'text');
      lbl.setAttribute('x', pad.left - 8);
      lbl.setAttribute('y', y + 4);
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('fill', textCol);
      lbl.setAttribute('font-size', '11');
      lbl.setAttribute('font-family', 'ui-monospace,monospace');
      lbl.textContent = v.toFixed(1) + (this.options.yUnit || '');
      svg.appendChild(lbl);
    }

    // Axes
    const xAxis = document.createElementNS(this.svgNS, 'line');
    xAxis.setAttribute('x1', pad.left); xAxis.setAttribute('x2', pad.left + chartW);
    xAxis.setAttribute('y1', baseY);    xAxis.setAttribute('y2', baseY);
    xAxis.setAttribute('stroke', axisCol); xAxis.setAttribute('stroke-width', '1.5');
    svg.appendChild(xAxis);

    // Group sizing
    const groupW    = chartW / n;
    const barGap    = 4;
    const barW      = Math.min(50, (groupW - (nSets + 1) * barGap) / nSets);

    labels.forEach((label, gi) => {
      const groupLeft = pad.left + gi * groupW;
      const groupCenter = groupLeft + groupW / 2;

      datasets.forEach((ds, di) => {
        const val  = ds.values[gi];
        const barH = (val / maxVal) * chartH;
        const x    = groupCenter - (nSets * barW + (nSets - 1) * barGap) / 2 + di * (barW + barGap);
        const y    = baseY - barH;

        const rect = document.createElementNS(this.svgNS, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', baseY);
        rect.setAttribute('width', barW);
        rect.setAttribute('height', 0);
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', ds.color);
        svg.appendChild(rect);

        // Value label above bar
        const valLbl = document.createElementNS(this.svgNS, 'text');
        valLbl.setAttribute('x', x + barW / 2);
        valLbl.setAttribute('y', y - 6);
        valLbl.setAttribute('text-anchor', 'middle');
        valLbl.setAttribute('fill', textCol);
        valLbl.setAttribute('font-size', '10');
        valLbl.setAttribute('font-weight', 'bold');
        valLbl.setAttribute('font-family', 'ui-monospace,monospace');
        valLbl.style.opacity = '0';
        valLbl.textContent = val + (this.options.yUnit || '');
        svg.appendChild(valLbl);

        requestAnimationFrame(() => {
          setTimeout(() => {
            rect.style.transition = 'y 0.8s cubic-bezier(0.16,1,0.3,1), height 0.8s cubic-bezier(0.16,1,0.3,1)';
            rect.setAttribute('y', y);
            rect.setAttribute('height', barH);
            valLbl.style.transition = 'opacity 0.4s ease 0.6s';
            valLbl.style.opacity = '1';
          }, gi * 80 + di * 40);
        });
      });

      // Group X label
      const xLbl = document.createElementNS(this.svgNS, 'text');
      xLbl.setAttribute('x', groupCenter);
      xLbl.setAttribute('y', baseY + 22);
      xLbl.setAttribute('text-anchor', 'middle');
      xLbl.setAttribute('fill', textCol);
      xLbl.setAttribute('font-size', '12');
      xLbl.setAttribute('font-weight', '600');
      xLbl.setAttribute('font-family', 'ui-monospace,monospace');
      xLbl.textContent = label;
      svg.appendChild(xLbl);
    });

    // Y Axis title
    if (this.options.yAxisTitle) {
      const yt = document.createElementNS(this.svgNS, 'text');
      yt.setAttribute('transform', `translate(14,${pad.top + chartH / 2}) rotate(-90)`);
      yt.setAttribute('text-anchor', 'middle');
      yt.setAttribute('fill', textCol);
      yt.setAttribute('font-size', '11');
      yt.setAttribute('font-family', 'ui-monospace,monospace');
      yt.textContent = this.options.yAxisTitle;
      svg.appendChild(yt);
    }

    // Legend at top
    const legendY = 22;
    let legendX = pad.left;
    datasets.forEach(ds => {
      const dot = document.createElementNS(this.svgNS, 'rect');
      dot.setAttribute('x', legendX); dot.setAttribute('y', legendY - 9);
      dot.setAttribute('width', 14); dot.setAttribute('height', 10);
      dot.setAttribute('rx', '3'); dot.setAttribute('fill', ds.color);
      svg.appendChild(dot);

      const lbl = document.createElementNS(this.svgNS, 'text');
      lbl.setAttribute('x', legendX + 18);
      lbl.setAttribute('y', legendY);
      lbl.setAttribute('fill', textCol);
      lbl.setAttribute('font-size', '12');
      lbl.setAttribute('font-family', 'ui-monospace,monospace');
      lbl.textContent = ds.label;
      svg.appendChild(lbl);

      legendX += 20 + ds.label.length * 7.5;
    });

    // Title
    if (this.options.title) {
      const title = document.createElement('div');
      title.style.cssText = `text-align:center;font-size:0.85rem;font-weight:600;font-family:ui-monospace,monospace;color:${textCol};padding:10px 0 0;`;
      title.textContent = this.options.title;
      this.container.appendChild(title);
    }

    this.container.appendChild(svg);
  }
}

window.GroupedBarChart = GroupedBarChart;

