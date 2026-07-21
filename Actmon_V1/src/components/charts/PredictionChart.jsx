import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';

export const PredictionChart = ({
  data,
  nowTimestamp,
  height = 350,
  metricLabel = 'Value',
}) => {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
          <XAxis
            dataKey="timestamp"
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            dy={8}
          />
          <YAxis
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            domain={[0, (dataMax) => Math.min(100, Math.ceil(dataMax * 1.1))]}
            dx={-8}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #EDEBE9',
              borderRadius: '6px',
              fontSize: '12px',
              boxShadow: 'var(--shadow-card)',
            }}
          />
          <Legend
            verticalAlign="top"
            height={36}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: '12px' }}
          />

          {/* Shaded Area for Confidence Interval: Range confidence_lower to confidence_upper */}
          <Area
            name="95% Confidence Interval"
            type="monotone"
            dataKey={['confidence_lower', 'confidence_upper']}
            stroke="none"
            fill="#0078D4"
            fillOpacity={0.15}
            connectNulls
          />

          {/* Historical Actual Line */}
          <Line
            name={`Historical ${metricLabel}`}
            type="monotone"
            dataKey="historical_value"
            stroke="#0078D4"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6 }}
          />

          {/* Forecasted Line */}
          <Line
            name={`Forecasted ${metricLabel}`}
            type="monotone"
            dataKey="predicted_value"
            stroke="#D83B01"
            strokeDasharray="5 5"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6 }}
          />

          {/* Vertical boundary showing 'NOW' */}
          {nowTimestamp && (
            <ReferenceLine
              x={nowTimestamp}
              stroke="#D83B01"
              strokeWidth={1.5}
              label={{
                value: 'NOW',
                position: 'top',
                fill: '#D83B01',
                fontSize: 10,
                fontWeight: 'bold',
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};
