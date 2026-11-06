from datetime import date
import importlib.util
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "Data Relay 数据转存系统配置操作指南.docx"


def load_manual_helpers():
    source = ROOT / "scripts" / "create-usage-manual.py"
    spec = importlib.util.spec_from_file_location("data_relay_manual_helpers", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def add_cover(doc, helpers):
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(68)

    brand = doc.add_paragraph()
    brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = brand.add_run("DR")
    helpers.set_run_font(run, size=18, bold=True)

    title = doc.add_paragraph(style="Title")
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_before = Pt(34)
    title.paragraph_format.space_after = Pt(12)
    title_run = title.add_run("Data Relay 数据转存系统")
    helpers.set_run_font(title_run, size=29, bold=True)
    helpers.suppress_paragraph_borders(title)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle.paragraph_format.space_after = Pt(54)
    subtitle_run = subtitle.add_run("配置操作指南")
    helpers.set_run_font(subtitle_run, size=18, bold=True)

    for text in (
        "适用版本  0.3.2",
        "适用环境  Windows x64 离线交付包",
        "适用人员  现场配置和运维人员",
        f"修订日期  {date.today().year} 年 {date.today().month} 月 {date.today().day} 日",
    ):
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.paragraph_format.space_after = Pt(9)
        helpers.set_run_font(paragraph.add_run(text), size=11)

    intro = doc.add_paragraph()
    intro.paragraph_format.space_before = Pt(58)
    intro.paragraph_format.line_spacing = 1.45
    helpers.set_run_font(
        intro.add_run(
            "本指南只说明安装完成后的必要配置。先核对交付包的授权模式；授权版完成软件激活，免授权版直接进入 TCP 参数、KH 连接、点位同步、设备映射和重启验证。"
        ),
        size=11,
    )
    doc.add_page_break()


def build_document():
    h = load_manual_helpers()
    doc = Document()
    h.configure_document(doc)

    header = doc.sections[0].header.paragraphs[0]
    header.text = ""
    header_run = header.add_run("Data Relay 数据转存系统配置操作指南")
    h.set_run_font(header_run, size=9, color=h.MID_GRAY)

    add_cover(doc, h)

    h.heading(doc, "1 配置前准备")
    h.add_body(
        doc,
        "准备 FDBServer REST 服务地址、KH 账号密码、KH 完整点位名称和设备 STC。授权版还需准备当前服务器的激活文件。现场设备应能配置目标服务器 IP 和端口，并主动通过 TCP 发送报文。",
    )
    h.add_table(
        doc,
        ["项目", "默认值或要求"],
        [
            ("管理后台", "http://服务器 IP:8080"),
            ("初始密码", "Administrator"),
            ("TCP 监听端口", "默认 9000，以转发配置页面保存值为准"),
            ("设备报文", "以 @ 开始、以 # 结束，包含 STC 和 TM"),
            ("KH 接口", "FDBServer 对外提供的 REST 地址，不是 KH 数据库端口"),
        ],
        widths=[1.65, 4.9],
    )
    h.add_note(doc, "首次使用  ", "登录后应尽快修改交付目录 .env 中的 ADMIN_PASSWORD，并运行 restart.cmd。")

    h.heading(doc, "2 确认授权模式")
    h.add_steps(
        doc,
        [
            "打开 VERSION.json，确认 licenseMode 与交付要求一致：licensed 表示授权版，unlicensed 表示免授权版。",
            "授权版登录后进入软件授权页，复制本机机器码，提交客户、项目、设备数量上限和授权有效期。",
            "授权版收到 .lic 文件后选择该文件，点击验证并激活，确认设备上限和到期时间正确。",
            "免授权版不显示软件授权菜单，无需机器码和 .lic 文件，可直接进入转发配置。",
        ],
    )
    h.add_note(doc, "授权限制  ", "授权版的设备上限按已启用设备计算。授权到期后 KH 写入暂停，续期激活后继续处理。免授权版不限制设备数量和有效期。")

    h.heading(doc, "3 转发配置")
    h.add_body(doc, "进入转发配置页面，按以下顺序填写并保存。TCP 监听参数修改后必须重启服务才能生效。")

    h.heading(doc, "3.1 TCP 和协议参数", 2)
    h.add_table(
        doc,
        ["参数", "建议值", "说明"],
        [
            ("监听 IP", "0.0.0.0", "监听服务器所有网卡"),
            ("监听端口", "9000", "设备目标端口必须与此一致"),
            ("最大连接数", "1000", "满足 300 台以上设备接入"),
            ("空闲超时", "180000 毫秒", "连续无数据达到该时间后断开连接"),
            ("TCP Keepalive", "启用", "操作系统探测失效连接，不是设备心跳"),
            ("LEN 策略", "记录警告", "长度算法现场确认前不要使用严格拒绝"),
            ("校验策略", "记录警告", "校验算法现场确认前不要使用严格拒绝"),
            ("设备时区", "Asia/Shanghai", "用于解释 TM 采集时间"),
        ],
        widths=[1.55, 1.55, 3.45],
    )
    h.add_note(doc, "设备侧  ", "目标 IP 填 Data Relay 服务器 IP，目标端口填本页监听端口。设备直接发送报文，系统不要求应用层心跳或 ACK。")

    h.heading(doc, "3.2 KingHistorian 参数", 2)
    h.add_table(
        doc,
        ["参数", "填写说明"],
        [
            ("启用 KH 写入", "首次配置先关闭，完成连接和映射验证后再启用"),
            ("FDBServer Base URL", "例如 http://192.168.3.26:4568，端口必须是 REST 服务端口"),
            ("用户名和密码", "填写客户提供的 KH 访问账号"),
            ("clientName", "默认 data-relay，同一现场保持固定"),
            ("请求超时", "默认 10000 毫秒"),
            ("单批点数", "默认 100"),
            ("快速重试次数", "默认 12"),
        ],
        widths=[1.8, 4.75],
    )
    h.add_steps(
        doc,
        [
            "填写 FDBServer Base URL、用户名、密码和 clientName，点击保存配置。",
            "点击注册客户端。",
            "点击测试连接，确认连接成功。",
            "点击同步 KH 点位，确认同步数量合理。",
        ],
    )
    h.add_note(doc, "点位同步  ", "同步只读取 KH 已有点位，不会自动建点。缺少的点位应先在 KH 中建立，再回到系统重新同步。")

    h.heading(doc, "4 设备和点位映射")
    h.add_body(doc, "设备首次发送格式正确的报文后，会以待配置设备出现在设备管理列表。系统以报文中的 STC 识别设备。")

    h.heading(doc, "4.1 配置设备", 2)
    h.add_steps(
        doc,
        [
            "让设备连接 Data Relay 并至少发送一帧报文。",
            "进入设备管理，按 STC 找到待配置设备并打开配置。",
            "填写现场真实设备名称，核对 STC、SN、IMEI 和上报周期。",
            "暂不启用设备转发，先完成全部需要存储字段的 KH 点位映射。",
        ],
    )

    h.heading(doc, "4.2 配置字段映射", 2)
    h.add_table(
        doc,
        ["配置项", "操作要求"],
        [
            ("字段", "来自设备报文，例如 V、A01、P01"),
            ("完整 KH 点位", "从同步结果中选择实际存在的完整点位名称"),
            ("写入类型", "测量值通常用 DOUBLE；累计量通常用 INT；状态量按 KH 点位选择 BOOL 或 INT"),
            ("倍率", "默认 1"),
            ("偏移", "默认 0"),
            ("写入", "仅勾选需要存储和转发的字段"),
        ],
        widths=[1.65, 4.9],
    )
    h.add_body(doc, "最终写入值等于原始值乘以倍率再加偏移。同一个 KH 点位只能绑定一个设备字段。")
    h.add_note(doc, "批量历史帧  ", "A01、A02、P01、P02 等字段使用竖线分隔多个值时，每个字段仍只配置一次 KH 点位。系统按照 TM、D 和 T 自动展开多个历史时刻；V、V1 等单值字段只在 TM 时间写入一次。")
    h.add_body(doc, "Windows 现场可运行 simulate-batch.cmd 模拟3台设备持续发送批量帧。默认每帧包含8个样本，样本间隔30分钟；先短时运行完成设备发现和映射，再启用 KH 写入进行整链路验证。")
    h.add_steps(
        doc,
        [
            "选择每个需要存储字段对应的 KH 点位和写入类型。",
            "勾选需要写入的字段，未勾选字段不会保存和转发。",
            "保存设备配置。",
            "重新打开配置确认无校验错误，再勾选启用设备转发并保存。",
        ],
    )
    h.add_note(doc, "未配置设备  ", "未完成配置的设备只登记身份和最后接收时间，不保存原始报文，也不会写入 KH。")

    h.heading(doc, "5 启用和验证")
    h.add_steps(
        doc,
        [
            "回到转发配置，勾选启用 KH 写入并保存。",
            "在安装目录运行 restart.cmd。",
            "运行 status.cmd，确认 PM2 中 data-relay 状态为 online。",
            "让设备连续发送至少两个上报周期。",
            "在设备管理中确认最后接收时间持续更新。",
            "在 KH 中确认点位值、点位名称和 TM 采集时间正确。",
            "对于批量历史帧，确认同一 KH 点位按 D 间隔出现 T 条历史数据。",
            "如有异常，进入日志查询，按设备、错误时间或关联标识检索。",
            "现场验证通过后，备份 data、.env 和 config；授权版同时妥善保留 .lic 文件。",
        ],
    )
    h.add_table(
        doc,
        ["投运确认项", "结果"],
        [
            ("授权模式符合交付要求；授权版已激活", "□"),
            ("设备目标 IP 和 TCP 端口正确", "□"),
            ("KH 注册、测试和点位同步成功", "□"),
            ("每台设备只启用需要写入的字段", "□"),
            ("KH 点位没有重复绑定，写入类型正确", "□"),
            ("最后接收时间和 KH 数据持续更新", "□"),
            ("批量帧的历史点数量、数值和时间间隔正确", "□"),
            ("PM2 开机启动已经验证", "□"),
        ],
        widths=[5.75, 0.8],
        center_columns=[1],
    )

    h.heading(doc, "6 常用服务脚本")
    h.add_table(
        doc,
        ["脚本", "用途"],
        [
            ("start.cmd", "启动 Data Relay"),
            ("stop.cmd", "停止 Data Relay"),
            ("restart.cmd", "修改配置后重启服务"),
            ("status.cmd", "查看 PM2 服务状态"),
            ("logs.cmd", "查看最近控制台错误，按 Ctrl C 退出"),
        ],
        widths=[2.0, 4.55],
    )
    doc.core_properties.title = "Data Relay 数据转存系统配置操作指南"
    doc.core_properties.subject = "Data Relay 安装后的必要配置步骤"
    doc.core_properties.author = "Data Relay 项目组"
    doc.core_properties.keywords = "Data Relay TCP KingHistorian FDBServer 配置指南"
    doc.save(OUTPUT)
    h.embed_font(OUTPUT, ROOT / "assets" / "fonts" / "NotoSansCJKsc-Regular.otf", h.FONT_CN)
    print(OUTPUT)


if __name__ == "__main__":
    build_document()
