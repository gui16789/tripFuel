# 车辆使用明细表 MVP

## 已实现

- 固定出发点，默认是 `安盟财产保险有限公司长春中心支公司`。
- 人工维护目的地清单：`vehicle_usage_destinations.csv`。
- 支持两种距离来源：
  - `distance_km` 有值：直接使用该里程，适合离线验证。
  - `distance_km` 留空：调用高德 Web 服务，自动计算驾车距离。
- 写入 Excel 的 `车辆使用明细表`：
  - 总里程：驾车距离取整后的 km。
  - 所耗燃油数量：`总里程 * 单公里油耗`。
  - 燃油费总额：`所耗燃油数量 * 燃油费单价`。
  - 百公里油耗：`所耗燃油数量 / 总里程 * 100`。

## 本地在线编辑器

启动：

```powershell
$env:AMAP_KEY="你的高德Web服务Key"
python app.py
```

打开：

```text
http://127.0.0.1:8000
```

编辑器支持：

- 出发地固定为 `安盟财产保险有限公司长春中心支公司`。
- 输入目的地关键词，调用高德 POI 搜索，人工选择候选后自动设为目的地。
- 需要中途停靠时，点击“添加途经点”，继续搜索并选择候选地点；途经点会插入目的地上方。
- 选择日期后，自动匹配本地 `fuel_prices_changchun_92.csv` 中的吉林长春 92 号油价。
- 点击“计算距离”后调用高德驾车路径规划。
- 点击“加入明细”形成记录。
- 点击“导出Excel”后浏览器下载带时间戳的 `.xlsx` 文件。

本地油价表来自吉林省发改委公告，按公告“24时起执行”折算为次日生效日期。

## 离线验证

```powershell
python generate_vehicle_usage.py --input 加油明细.xlsx --output 加油明细_mvp生成.xlsx --destinations vehicle_usage_destinations.csv
```

## 使用高德自动算距离

方式一：从 `vehicle_usage_destinations.csv` 读取目的地。

1. 在 `vehicle_usage_destinations.csv` 中清空需要自动计算的 `distance_km`。
2. 设置高德 Web 服务 Key：

```powershell
$env:AMAP_KEY="你的高德Web服务Key"
```

3. 运行：

```powershell
python generate_vehicle_usage.py --input 加油明细.xlsx --output 加油明细_mvp生成.xlsx --destinations vehicle_usage_destinations.csv --origin 安盟财产保险有限公司长春中心支公司 --city 长春
```

方式二：直接从 Excel 的 `车辆使用明细表` 读取出发地、目的地和油价。

```powershell
python generate_vehicle_usage.py --source sheet --input 加油明细.xlsx --output 加油明细_mvp生成.xlsx --city 长春
```

只测试前 N 条：

```powershell
python generate_vehicle_usage.py --source sheet --limit 10 --input 加油明细.xlsx --output 加油明细_mvp高德测试前10条.xlsx --city 长春
```

## 多目的地

`destination` 支持用 `-` 或 `—` 分隔多个停靠点，例如：

```csv
origin,date,destination,fuel_price,distance_km
,2026-04-30,农安-九台财产险资源,8.29,
```

脚本会按 `出发点 -> 农安 -> 九台财产险资源` 计算驾车路线。
