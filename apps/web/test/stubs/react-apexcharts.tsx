// ApexCharts needs a real browser; in jsdom the chart is replaced by its data.
export default function ReactApexChart(props: { series?: unknown; type?: string }) {
  return <div data-chart={props.type}>{JSON.stringify(props.series)}</div>;
}
