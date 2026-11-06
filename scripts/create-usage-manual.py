from pathlib import Path
import uuid
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from lxml import etree


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "Data Relay 数据转存系统安装后使用说明.docx"

FONT_CN = "Noto Sans CJK SC"
FONT_LATIN = "Noto Sans CJK SC"
NAVY = "1F4E78"
PALE_BLUE = "EAF2F8"
PALE_GRAY = "F5F7F9"
MID_GRAY = "666666"
LIGHT_BORDER = "D9D9D9"


def embed_font(docx_path, font_path, family):
    w_ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    r_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    font_key = uuid.uuid4()
    key = font_key.bytes
    font_data = bytearray(font_path.read_bytes())
    for index in range(min(32, len(font_data))):
        font_data[index] ^= key[15 - (index % 16)]

    temporary = docx_path.with_suffix(".embedded.tmp.docx")
    with ZipFile(docx_path, "r") as source, ZipFile(temporary, "w", ZIP_DEFLATED) as target:
        names = set(source.namelist())
        font_table = etree.fromstring(source.read("word/fontTable.xml"))
        font = font_table.find(f"{{{w_ns}}}font[@{{{w_ns}}}name='{family}']")
        if font is None:
            font = etree.SubElement(font_table, f"{{{w_ns}}}font")
            font.set(f"{{{w_ns}}}name", family)
            family_node = etree.SubElement(font, f"{{{w_ns}}}family")
            family_node.set(f"{{{w_ns}}}val", "swiss")
            pitch = etree.SubElement(font, f"{{{w_ns}}}pitch")
            pitch.set(f"{{{w_ns}}}val", "variable")

        rel_path = "word/_rels/fontTable.xml.rels"
        if rel_path in names:
            relationships = etree.fromstring(source.read(rel_path))
        else:
            relationships = etree.Element(f"{{{rel_ns}}}Relationships", nsmap={None: rel_ns})
        existing_ids = {item.get("Id") for item in relationships}
        number = 1
        while f"rId{number}" in existing_ids:
            number += 1
        relationship_id = f"rId{number}"
        relationship = etree.SubElement(relationships, f"{{{rel_ns}}}Relationship")
        relationship.set("Id", relationship_id)
        relationship.set("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font")
        relationship.set("Target", "fonts/NotoSansCJKsc-Regular.odttf")

        embed = etree.SubElement(font, f"{{{w_ns}}}embedRegular")
        embed.set(f"{{{r_ns}}}id", relationship_id)
        embed.set(f"{{{w_ns}}}fontKey", "{" + str(font_key).upper() + "}")

        content_types = etree.fromstring(source.read("[Content_Types].xml"))
        if not content_types.xpath("ct:Default[@Extension='odttf']", namespaces={"ct": ct_ns}):
            default = etree.SubElement(content_types, f"{{{ct_ns}}}Default")
            default.set("Extension", "odttf")
            default.set("ContentType", "application/vnd.openxmlformats-officedocument.obfuscatedFont")

        replacements = {
            "word/fontTable.xml": etree.tostring(font_table, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            rel_path: etree.tostring(relationships, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            "[Content_Types].xml": etree.tostring(content_types, xml_declaration=True, encoding="UTF-8", standalone="yes"),
        }
        for info in source.infolist():
            if info.filename == rel_path and rel_path not in names:
                continue
            target.writestr(info, replacements.get(info.filename, source.read(info.filename)))
        if rel_path not in names:
            target.writestr(rel_path, replacements[rel_path])
        target.writestr("word/fonts/NotoSansCJKsc-Regular.odttf", bytes(font_data))
    temporary.replace(docx_path)


def set_run_font(run, size=None, bold=None, color="000000", latin=FONT_LATIN, east_asia=FONT_CN):
    run.font.name = latin
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), east_asia)
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), latin)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), latin)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def shade_cell(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=110, start=120, bottom=110, end=120):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_cell_borders(cell, color=LIGHT_BORDER, size="6"):
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = f"w:{edge}"
        node = borders.find(qn(tag))
        if node is None:
            node = OxmlElement(tag)
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), size)
        node.set(qn("w:color"), color)


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    tr_pr.append(cant_split)


def set_cell_text(cell, text, *, bold=False, color="000000", align=WD_ALIGN_PARAGRAPH.LEFT, size=9.5):
    cell.text = ""
    paragraph = cell.paragraphs[0]
    paragraph.alignment = align
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.line_spacing = 1.15
    run = paragraph.add_run(str(text))
    set_run_font(run, size=size, bold=bold, color=color)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def add_table(doc, headers, rows, widths=None, center_columns=None):
    center_columns = set(center_columns or [])
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    table.allow_autofit = False
    table.rows[0]._tr.get_or_add_trPr()
    set_repeat_table_header(table.rows[0])
    for index, (cell, header) in enumerate(zip(table.rows[0].cells, headers)):
        if widths:
            cell.width = Inches(widths[index])
        shade_cell(cell, NAVY)
        set_cell_borders(cell)
        set_cell_margins(cell)
        set_cell_text(cell, header, bold=True, color="FFFFFF", align=WD_ALIGN_PARAGRAPH.CENTER, size=9.3)
    for row_index, values in enumerate(rows):
        row = table.add_row()
        prevent_row_split(row)
        for index, (cell, value) in enumerate(zip(row.cells, values)):
            if widths:
                cell.width = Inches(widths[index])
            if row_index % 2:
                shade_cell(cell, PALE_GRAY)
            set_cell_borders(cell)
            set_cell_margins(cell)
            alignment = WD_ALIGN_PARAGRAPH.CENTER if index in center_columns else WD_ALIGN_PARAGRAPH.LEFT
            set_cell_text(cell, value, align=alignment)
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(2)
    return table


def add_body(doc, text, *, bold_lead=None, keep_with_next=False):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(6)
    paragraph.paragraph_format.line_spacing = 1.35
    paragraph.paragraph_format.keep_with_next = keep_with_next
    if bold_lead and text.startswith(bold_lead):
        lead = paragraph.add_run(bold_lead)
        set_run_font(lead, size=10.8, bold=True)
        rest = paragraph.add_run(text[len(bold_lead):])
        set_run_font(rest, size=10.8)
    else:
        run = paragraph.add_run(text)
        set_run_font(run, size=10.8)
    return paragraph


def add_bullets(doc, items, level=0):
    for item in items:
        paragraph = doc.add_paragraph(style="List Bullet" if level == 0 else "List Bullet 2")
        paragraph.paragraph_format.space_after = Pt(3)
        paragraph.paragraph_format.line_spacing = 1.25
        paragraph.add_run(item)
        for run in paragraph.runs:
            set_run_font(run, size=10.5)


def add_steps(doc, items):
    for index, item in enumerate(items, 1):
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Inches(0.34)
        paragraph.paragraph_format.first_line_indent = Inches(-0.26)
        paragraph.paragraph_format.space_after = Pt(5)
        paragraph.paragraph_format.line_spacing = 1.3
        number_run = paragraph.add_run(f"{index}. ")
        number_run.bold = True
        paragraph.add_run(item)
        for current in paragraph.runs:
            set_run_font(current, size=10.6)


def add_code(doc, text):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.left_indent = Inches(0.25)
    paragraph.paragraph_format.right_indent = Inches(0.25)
    paragraph.paragraph_format.space_before = Pt(3)
    paragraph.paragraph_format.space_after = Pt(7)
    paragraph.paragraph_format.line_spacing = 1.15
    p_pr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), "F2F2F2")
    p_pr.append(shd)
    run = paragraph.add_run(text)
    set_run_font(run, size=9.3, latin="Consolas", east_asia=FONT_CN)


def add_note(doc, lead, text):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(3)
    paragraph.paragraph_format.space_after = Pt(7)
    paragraph.paragraph_format.line_spacing = 1.3
    lead_run = paragraph.add_run(lead)
    set_run_font(lead_run, size=10.4, bold=True)
    text_run = paragraph.add_run(text)
    set_run_font(text_run, size=10.4)


def add_page_number(paragraph):
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("第 ")
    set_run_font(run, size=9, color=MID_GRAY)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    run_node = OxmlElement("w:r")
    text_node = OxmlElement("w:t")
    text_node.text = "1"
    run_node.append(text_node)
    field.append(run_node)
    paragraph._p.append(field)
    tail = paragraph.add_run(" 页")
    set_run_font(tail, size=9, color=MID_GRAY)


def suppress_paragraph_borders(paragraph_or_style):
    element = paragraph_or_style._element
    p_pr = element.get_or_add_pPr()
    existing = p_pr.find(qn("w:pBdr"))
    if existing is not None:
        p_pr.remove(existing)
    borders = OxmlElement("w:pBdr")
    for edge in ("top", "left", "bottom", "right", "between", "bar"):
        node = OxmlElement(f"w:{edge}")
        node.set(qn("w:val"), "nil")
        borders.append(node)
    p_pr.append(borders)


def configure_document(doc):
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.72)
    section.bottom_margin = Inches(0.68)
    section.left_margin = Inches(0.78)
    section.right_margin = Inches(0.78)
    section.header_distance = Inches(0.3)
    section.footer_distance = Inches(0.3)
    section.different_first_page_header_footer = True

    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT_LATIN
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
    normal.font.size = Pt(10.8)
    normal.font.color.rgb = RGBColor(0, 0, 0)

    title = styles["Title"]
    title.font.name = FONT_LATIN
    title._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
    title.font.size = Pt(28)
    title.font.bold = True
    title.font.color.rgb = RGBColor(0, 0, 0)
    suppress_paragraph_borders(title)

    heading_sizes = {"Heading 1": 18, "Heading 2": 14, "Heading 3": 11.5}
    for name, size in heading_sizes.items():
        style = styles[name]
        style.font.name = FONT_LATIN
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.paragraph_format.space_before = Pt(12 if name == "Heading 1" else 9)
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.keep_with_next = True
        style.paragraph_format.keep_together = True

    for style_name in ("List Bullet", "List Bullet 2", "List Number"):
        style = styles[style_name]
        style.font.name = FONT_LATIN
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
        style.font.size = Pt(10.5)
        style.font.color.rgb = RGBColor(0, 0, 0)

    header = section.header.paragraphs[0]
    header.alignment = WD_ALIGN_PARAGRAPH.LEFT
    header_run = header.add_run("Data Relay 数据转存系统安装后使用说明")
    set_run_font(header_run, size=9, color=MID_GRAY)
    add_page_number(section.footer.paragraphs[0])


def heading(doc, text, level=1):
    paragraph = doc.add_heading(text, level=level)
    for run in paragraph.runs:
        set_run_font(run, size={1: 18, 2: 14, 3: 11.5}.get(level, 11), bold=True)
    return paragraph


def add_section_break(doc):
    doc.add_page_break()


def build_document():
    doc = Document()
    configure_document(doc)

    # Cover
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(58)
    brand = doc.add_paragraph()
    brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
    brand_run = brand.add_run("DR")
    set_run_font(brand_run, size=17, bold=True)
    brand.paragraph_format.space_after = Pt(22)

    title = doc.add_paragraph(style="Title")
    suppress_paragraph_borders(title)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title.add_run("Data Relay 数据转存系统")
    set_run_font(title_run, size=28, bold=True)
    title.paragraph_format.space_after = Pt(10)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle_run = subtitle.add_run("安装后使用说明")
    set_run_font(subtitle_run, size=17, bold=True)
    subtitle.paragraph_format.space_after = Pt(38)

    for line in (
        "适用版本  0.2.1",
        "适用环境  Windows x64 离线交付包",
        "适用对象  现场管理员和运维人员",
        "修订日期  2026 年 9 月 30 日",
    ):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(8)
        run = p.add_run(line)
        set_run_font(run, size=11)

    intro = doc.add_paragraph()
    intro.paragraph_format.space_before = Pt(48)
    intro.paragraph_format.left_indent = Inches(0.55)
    intro.paragraph_format.right_indent = Inches(0.55)
    intro.paragraph_format.line_spacing = 1.45
    intro.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    intro_run = intro.add_run("本说明用于软件安装完成后的日常操作。管理员按照文档完成软件激活、转发配置、设备点位映射和运行检查后，现场设备报文即可通过 TCP 接入，并由系统转存到 KingHistorian。")
    set_run_font(intro_run, size=11)

    add_section_break(doc)

    heading(doc, "1 使用范围和操作顺序")
    add_body(doc, "Data Relay 接收现场设备主动建立的 TCP 连接，解析以 @ 开始、以 # 结束的文本报文，再把已启用字段写入指定的 KingHistorian 点位。设备直接发送报文，系统不要求应用层心跳，也不向设备返回 ACK。")
    add_note(doc, "开始使用前  ", "确认 Windows 服务已经启动，浏览器能够访问管理后台，并准备好激活文件、FDBServer 地址和 KH 点位信息。")

    heading(doc, "1.1 首次配置顺序", 2)
    add_table(doc, ["顺序", "操作", "完成标志"], [
        ("1", "登录管理后台", "看到设备管理页面，左下角显示服务状态"),
        ("2", "导入激活码", "软件授权显示授权有效，设备用量上限正确"),
        ("3", "配置 TCP 和协议参数", "保存配置并重启服务后，设备端口开始监听"),
        ("4", "配置 FDBServer 并注册客户端", "测试连接成功"),
        ("5", "同步 KH 点位", "系统提示已同步的点位数量"),
        ("6", "配置设备和字段映射", "设备显示已启用，KH 点位映射数量正确"),
        ("7", "发送现场报文并核验", "最后接收时间更新，KH 中出现对应时间和值"),
    ], widths=[0.55, 2.35, 3.65], center_columns=[0])

    heading(doc, "1.2 管理后台入口", 2)
    add_body(doc, "在与服务器网络互通的电脑上打开浏览器，访问以下地址。服务器 IP 应替换为 Data Relay 所在 Windows 服务器的实际地址。")
    add_code(doc, "http://服务器IP:8080")
    add_table(doc, ["项目", "默认值", "使用说明"], [
        ("管理员账号", "admin", "系统为单管理员后台，登录页面只要求输入密码"),
        ("初始密码", "Administrator", "首次验证后应修改交付目录 .env 中的 ADMIN_PASSWORD"),
        ("管理端口", "8080", "仅向运维网段开放，不建议暴露到公网"),
        ("TCP 设备端口", "9000", "现场设备主动连接此端口，实际值以转发配置为准"),
    ], widths=[1.25, 1.55, 3.75], center_columns=[1])
    add_note(doc, "修改密码后  ", "运行 restart.cmd 重启服务。旧页面若仍保持登录状态，应退出并使用新密码重新登录。")

    heading(doc, "1.3 页面功能", 2)
    add_table(doc, ["菜单", "主要用途"], [
        ("设备管理", "查看自动发现的设备，维护设备名称、身份信息、上报周期和 KH 点位映射"),
        ("转发配置", "维护 TCP 监听、协议校验和 FDBServer 连接参数"),
        ("日志查询", "查询错误和警告，按级别、分类、设备或帧标识定位问题"),
        ("软件授权", "复制机器码、导入激活文件并查看授权设备数和到期时间"),
    ], widths=[1.35, 5.2])

    add_section_break(doc)

    heading(doc, "2 软件激活")
    add_body(doc, "软件授权与当前 Windows 服务器的机器码绑定，并限制可启用设备数量和授权有效期。更换服务器、重装导致机器码变化或激活码到期时，需要重新签发激活文件。")

    heading(doc, "2.1 获取并导入激活码", 2)
    add_steps(doc, [
        "进入软件授权页面，点击本机机器码右侧的复制按钮。",
        "将机器码、客户名称、项目名称、需要启用的设备数量和有效期提交给软件供应方。",
        "收到 .lic 文件后，点击选择 .lic 文件。文件内容会自动填入激活码文本框。",
        "点击验证并激活。页面提示激活成功后，检查授权编号、客户项目、设备用量、生效时间和到期时间。",
    ])
    add_note(doc, "激活失败时  ", "不要重复生成或修改 .lic 文件。先核对机器码和服务器系统时间，再把页面上的完整错误提示交给软件供应方。")

    heading(doc, "2.2 授权状态含义", 2)
    add_table(doc, ["状态", "含义", "处理方式"], [
        ("授权有效", "允许在授权上限内启用设备并写入 KH", "正常使用"),
        ("即将到期", "授权仍可使用，但剩余时间不多", "尽快申请续期激活码"),
        ("未激活", "尚未导入有效激活码", "复制机器码并申请激活"),
        ("已过期", "KH 写入暂停", "续期后重新导入激活码"),
        ("尚未生效", "当前时间早于授权生效时间", "核对生效日期和服务器时间"),
        ("机器不匹配", "激活码不属于当前服务器", "使用当前机器码重新签发"),
        ("系统时间异常", "检测到服务器时间明显回退", "校准系统时间后联系技术人员"),
        ("签名无效或密钥不支持", "激活码损坏或签名密钥不匹配", "使用原始 .lic 文件重新导入"),
    ], widths=[1.25, 2.45, 2.85])
    add_body(doc, "授权到期后，系统会停止向 KH 写入。已配置且处于授权范围内的设备数据会进入授权暂停队列，导入有效续期授权后继续处理。应及时续期，避免待处理数据长期占用磁盘。")

    heading(doc, "2.3 设备数量限制", 2)
    add_bullets(doc, [
        "授权数量按已启用设备计算，不按发现设备总数计算。",
        "待配置或已停用设备不占用授权数量。",
        "达到上限后不能继续启用新设备，可先停用或移除不再使用的设备，再启用新设备。",
        "设备用量可在软件授权页面查看，也会显示在设备配置窗口中。",
    ])

    heading(doc, "3 转发配置")
    add_body(doc, "进入转发配置页面后，先保存基础参数，再执行 KH 注册、测试和点位同步。页面提示保存成功并不代表监听参数已经切换；TCP 监听 IP、端口等参数需要重启服务后生效。")

    heading(doc, "3.1 TCP 接入参数", 2)
    add_table(doc, ["参数", "建议初值", "说明"], [
        ("监听 IP", "0.0.0.0", "监听服务器所有网卡；如需限制网卡，可填写指定本机 IP"),
        ("监听端口", "9000", "现场设备填写的目标端口，修改后需要重启服务"),
        ("最大连接数", "1000", "应大于现场设备总数，300 台设备无需为每台设备建立进程"),
        ("最大报文字节", "8192", "单帧超过此值会被判定为缓冲异常"),
        ("空闲超时", "180000 毫秒", "连接连续无数据达到该时间后会断开，设备可重新连接"),
        ("TCP Keepalive", "启用", "由操作系统探测失效连接，不是设备协议心跳"),
    ], widths=[1.4, 1.45, 3.7])
    add_note(doc, "设备侧配置  ", "目标 IP 填 Data Relay 服务器 IP，目标端口填本页的监听端口。设备应主动建立 TCP 连接并直接上传报文。")

    heading(doc, "3.2 协议校验参数", 2)
    add_table(doc, ["参数", "选项", "使用建议"], [
        ("LEN 策略", "记录警告 严格拒绝 关闭", "现场算法未确认前选择记录警告；确认长度规则后再考虑严格拒绝"),
        ("校验策略", "记录警告 严格拒绝 关闭", "现场校验算法未确认前选择记录警告"),
        ("校验算法", "现场待验证 XOR8 / SUM8 / LRC8", "必须与设备实际算法一致；选错后严格模式会拒绝报文"),
        ("设备时区", "Asia/Shanghai", "用于解释设备 TM 采集时间，现场服务器也应保持正确时间"),
    ], widths=[1.35, 2.15, 3.05])
    add_note(doc, "记录警告  ", "报文仍可继续处理，但日志会记录 LEN 或校验不一致。严格拒绝会把不符合规则的报文记为解析失败，不会生成 KH 写入任务。")

    heading(doc, "3.3 KingHistorian 参数", 2)
    add_table(doc, ["参数", "填写说明"], [
        ("启用 KH 写入", "首次配置时先不勾选；完成连接测试、点位同步和设备映射后再启用"),
        ("FDBServer Base URL", "填写 FDBServer REST 服务地址，例如 http://192.168.3.26:4568"),
        ("用户名和密码", "填写客户提供的 KH 访问账号；密码在页面中以掩码显示"),
        ("clientName", "客户端注册名称，默认 data-relay；同一套环境中保持固定"),
        ("请求超时", "单次 REST 请求等待时间，默认 10000 毫秒"),
        ("单批点数", "一次提交到 KH 的点位数量，默认 100"),
        ("快速重试次数", "连续失败转为低频持续重试前的次数，默认 12"),
    ], widths=[1.65, 4.9])
    add_note(doc, "端口区别  ", "Base URL 必须指向 FDBServer 对外提供 REST API 的端口。KH Server 数据库端口和 FDBServer REST 端口不是同一个概念，不要仅凭 KH 客户端能连接数据库端口就把该端口填到 Base URL。")

    heading(doc, "3.4 KH 首次配置步骤", 2)
    add_steps(doc, [
        "填写 FDBServer Base URL、用户名、密码和 clientName，点击保存配置。",
        "点击注册客户端。若失败，先检查 FDBServer 地址、端口和账号，再查看日志。",
        "点击测试连接。成功提示会显示当前能够枚举的 KH 点位数量。",
        "点击同步 KH 点位，把 KH 当前点位列表同步到 Data Relay。",
        "进入设备管理配置点位映射。确认至少一台设备写入正常后，再勾选启用 KH 写入并保存。",
        "运行 restart.cmd，使保存的监听和运行参数统一生效。",
    ])
    add_note(doc, "点位同步不建点  ", "同步操作只读取 KH 已有点位并保存到本地供映射选择，不会自动在 KH 中创建业务点位。若需要新点位，应先在 KH 中按现场规则建点，再回到系统重新同步。")

    heading(doc, "4 设备管理和点位映射")
    add_body(doc, "系统以报文中的 STC 作为设备身份。设备第一次发送格式正确的报文后，会以待配置设备出现在列表中。未配置设备只登记身份和最后接收时间，不保存原始报文，也不会写入 KH。")

    heading(doc, "4.1 查找和查看设备", 2)
    add_bullets(doc, [
        "可按设备名称、STC 或 SN 搜索。",
        "状态筛选支持全部设备、已启用和待配置或已停用。",
        "每页可显示 10、20、50 或 100 条记录。",
        "点击设备行后，右侧显示 STC、SN、IMEI、上报周期、已启用点位数和最后接收时间。",
        "列表中的 KH 点位映射显示已启用映射数和映射总数。",
    ])

    heading(doc, "4.2 设备基本信息", 2)
    add_table(doc, ["字段", "是否必填", "说明"], [
        ("设备名称", "是", "使用现场真实名称，例如 1 号进水流量计"),
        ("STC", "是", "设备站号，也是系统识别设备的主要标识；必须与报文一致"),
        ("SN", "否", "设备水表编号；自动发现时可从报文更新"),
        ("IMEI", "否", "通信模组序列号；自动发现时可从报文更新"),
        ("上报周期", "是", "单位为分钟；连续超过两倍周期未收到报文时生成离线警告"),
        ("启用设备转发", "是", "勾选后占用一个授权名额，并允许已映射字段进入存储和 KH 队列"),
    ], widths=[1.45, 1.0, 4.1], center_columns=[1])

    heading(doc, "4.3 字段映射规则", 2)
    add_body(doc, "每个报文字段必须明确绑定一个完整 KH 点位名称。系统不根据设备名或字段名自动拼接点位，也不允许同一个 KH 点位被多个设备或字段重复绑定。")
    add_table(doc, ["列", "填写规则"], [
        ("字段", "来自设备报文的字段名，例如 A01 或 P01"),
        ("业务含义", "便于现场识别的名称，可按实际业务修改"),
        ("完整 KH 点位", "从已同步列表选择或输入完整名称；启用写入时必须存在于同步列表"),
        ("写入类型", "选择传给 KH 接口的数据类型，必须与 KH 点位类型兼容"),
        ("倍率", "写入值计算公式中的乘数，默认 1"),
        ("偏移", "写入值计算公式中的加数，默认 0"),
        ("写入", "勾选后该字段才会生成 KH 写入任务；未勾选字段不会存储和转发"),
    ], widths=[1.25, 5.3])
    add_code(doc, "最终写入值 = 原始值 × 倍率 + 偏移")
    add_note(doc, "整数写入  ", "选择 INT 时，倍率和偏移计算后的结果会截去小数部分。一般不要对累计量随意设置倍率，除非现场已经确认单位换算规则。")

    heading(doc, "4.4 写入类型选择", 2)
    add_table(doc, ["写入类型", "适用数据", "建议字段"], [
        ("BOOL", "仅表示开或关的状态值；0 为 false，非 0 为 true", "K01 在 KH 点位为布尔型时"),
        ("INT", "整数、计数或累计量", "P01、P02、P03；K01 以整数保存时"),
        ("FLOAT", "单精度浮点值", "KH 点位明确为单精度时使用"),
        ("DOUBLE", "双精度测量值", "V V1 A01 A02 A03 A04"),
        ("STRING", "字符串点位", "仅在 KH 点位和业务确实要求字符串时使用"),
    ], widths=[1.15, 3.25, 2.15])
    add_note(doc, "保存校验  ", "系统会检查 KH 点位是否存在、是否已被其他映射占用，以及写入类型是否兼容。出现提示时不要绕过校验，应重新同步点位或选择正确类型。")

    heading(doc, "4.5 默认字段含义", 2)
    add_table(doc, ["字段", "默认业务含义", "默认写入类型"], [
        ("V", "GPRS 电压", "DOUBLE"),
        ("V1", "电池电压", "DOUBLE"),
        ("A01", "瞬时流量", "DOUBLE"),
        ("A02", "水表电压", "DOUBLE"),
        ("A03", "进水压力", "DOUBLE"),
        ("A04", "瞬时流速", "DOUBLE"),
        ("P01", "正累计流量", "INT"),
        ("P02", "负累计流量", "INT"),
        ("P03", "净累计流量", "INT"),
        ("K01", "开关量状态", "INT"),
    ], widths=[1.15, 3.25, 2.15], center_columns=[0, 2])
    add_note(doc, "现场确认  ", "A01 至 A04、P01 至 P03 是否出现以及具体业务含义取决于设备实际报文。默认名称只用于初始识别，现场应以客户确认的点表和实际报文为准。")

    heading(doc, "4.6 保存 启用和移除", 2)
    add_steps(doc, [
        "先关闭启用设备转发，填写设备信息和全部需要的字段映射后保存。",
        "重新打开设备配置，确认 KH 点位和写入类型无误，再勾选启用设备转发并保存。",
        "让设备连续上报至少两个周期，核对最后接收时间和 KH 中的值。",
        "不再使用的设备可点击移除设备。存在待写入 KH 数据时系统会拒绝移除，应先恢复 KH 写入并等待队列处理完成。",
    ])
    add_body(doc, "设备被移除后会从列表隐藏并停止转发，但历史报文和异常日志仍保留。设备再次上报时会以待配置设备重新出现，原映射不会自动恢复启用。")

    heading(doc, "5 日志查询和运行检查")
    add_body(doc, "管理后台只保存需要追踪的警告和错误，不记录每一帧成功报文。这样可以减少磁盘占用，同时保留设备断连、协议异常、授权异常和 KH 写入失败等关键信息。")

    heading(doc, "5.1 查询日志", 2)
    add_bullets(doc, [
        "搜索框支持消息、设备 ID、帧 ID 和批次 ID。",
        "级别可筛选错误或警告。",
        "分类可筛选 TCP、协议、设备、KH、配置和系统。授权类日志可在全部分类下搜索。",
        "每页可显示 10、20、50 或 100 条记录。",
        "关联标识用于把设备、原始帧和 KH 写入批次串联起来，排查时应一并记录。",
    ])

    heading(doc, "5.2 常见日志和处理方式", 2)
    add_table(doc, ["日志内容", "说明", "处理方式"], [
        ("设备连接空闲超时", "连接在空闲超时内没有收到数据", "检查上报周期、网络和设备程序；设备可重新连接"),
        ("连接关闭时存在未完成报文", "TCP 连接断开时只收到半帧", "检查设备是否在一帧发送完之前断开"),
        ("发现未配置设备", "系统已登记设备，但未保存报文", "进入设备管理完成映射和启用"),
        ("设备未配置有效 KH 点位", "设备已启用但没有可写入映射", "至少启用一个存在的 KH 点位映射"),
        ("LEN 与候选长度不一致", "报文声明长度与实际规则不一致", "记录样例并确认设备 LEN 计算范围"),
        ("校验值不匹配", "报文校验值与当前算法结果不一致", "核对校验算法和参与计算的字节范围"),
        ("报文解析失败", "报文边界、时间、数字或字段格式错误", "根据错误字段核对设备原始报文"),
        ("KH 写入失败", "REST 请求、鉴权、点位或数据类型出现问题", "检查日志详情、连接测试、点位和账号"),
        ("设备超过两倍周期未收到报文", "设备可能断网、断电或停止发送", "检查现场设备和网络"),
        ("授权将在若干天后到期", "系统提前提醒续期", "申请并导入续期激活码"),
    ], widths=[2.0, 2.0, 2.55])

    heading(doc, "5.3 日常检查清单", 2)
    add_table(doc, ["检查项", "正常表现", "异常时首先检查"], [
        ("服务状态", "左下角能够显示 TCP 连接数和授权状态", "status.cmd 和 logs.cmd"),
        ("设备接收", "最后接收时间按上报周期更新", "设备目标 IP 端口 网络和上报周期"),
        ("软件授权", "授权有效且剩余天数充足", "服务器时间和激活码有效期"),
        ("KH 连接", "测试连接成功且同步点位数量合理", "FDBServer 地址 账号和服务状态"),
        ("KH 数据", "点位值和 TM 采集时间持续更新", "字段映射 写入类型 日志和 KH 服务"),
        ("磁盘空间", "data 和 logs 所在磁盘空间充足", "KH 长期异常产生的待处理队列"),
    ], widths=[1.25, 2.75, 2.55])

    add_section_break(doc)

    heading(doc, "6 Windows 服务操作")
    add_body(doc, "以下脚本位于软件安装目录。建议通过脚本管理服务，不要直接结束 node.exe 进程。脚本使用随包 Node.js 和 PM2，不依赖系统全局安装。")
    add_table(doc, ["脚本", "用途", "操作说明"], [
        ("start.cmd", "启动服务", "启动 Data Relay 并保存 PM2 进程清单"),
        ("stop.cmd", "停止服务", "优雅停止 Data Relay，保留配置、数据和日志"),
        ("restart.cmd", "重启服务", "修改 .env 或转发配置后执行"),
        ("status.cmd", "查看状态", "PM2 表格中 data-relay 应为 online"),
        ("logs.cmd", "查看控制台日志", "显示最近 200 行并持续跟踪，按 Ctrl C 退出"),
        ("install-autostart-windows.ps1", "注册开机启动", "安装时由管理员 PowerShell 执行一次"),
        ("uninstall.cmd", "移除 PM2 进程", "不会删除 data 和 logs，确认不再运行时使用"),
    ], widths=[2.25, 1.4, 2.9])

    heading(doc, "6.1 修改管理员密码", 2)
    add_steps(doc, [
        "运行 stop.cmd 停止服务。",
        "用文本编辑器打开安装目录中的 .env。",
        "修改 ADMIN_PASSWORD 等号后的内容，避免使用空格和中文引号。",
        "保存文件并运行 start.cmd，再使用新密码登录。",
    ])
    add_code(doc, "ADMIN_PASSWORD=新的强密码")

    heading(doc, "6.2 安全备份", 2)
    add_body(doc, "升级程序、迁移服务器或进行重要配置调整前，应先停止服务并备份以下内容。备份过程中不要直接复制正在写入的 SQLite 数据库。")
    add_table(doc, ["对象", "位置", "用途"], [
        ("业务数据库", "data 目录", "设备、映射、待处理任务、异常日志和授权文件"),
        ("运行配置", ".env", "管理地址、密码、数据目录和运行参数"),
        ("授权公钥", "config 目录", "验证激活码签名"),
        ("运行日志", "logs 目录", "辅助排查 PM2 和程序异常，可按需要备份"),
    ], widths=[1.4, 1.45, 3.7])
    add_note(doc, "恢复原则  ", "同一份 data 目录不要被两个 Data Relay 实例同时使用。恢复或切换 source 和 jsc 包时，先停止旧实例，再复制备份并启动新实例。")

    add_section_break(doc)

    heading(doc, "7 常见故障处理")
    add_table(doc, ["现象", "排查顺序"], [
        ("管理页面打不开", "运行 status.cmd 确认服务状态；运行 logs.cmd 查看启动错误；检查 8080 端口、防火墙和访问地址"),
        ("密码无法登录", "确认账号为 admin；核对 .env 中 ADMIN_PASSWORD；修改后必须重启服务"),
        ("设备没有出现在列表", "检查设备目标 IP 和 TCP 端口；确认网络和防火墙；确认报文包含 STC 和 TM 且以 @ 和 # 包围"),
        ("设备出现但没有 KH 数据", "依次检查授权、设备启用、字段写入勾选、KH 写入开关、连接测试和日志"),
        ("保存映射提示点位不存在", "回到转发配置同步 KH 点位；确认 Base URL 指向正确 FDBServer；再选择完整点名"),
        ("保存映射提示类型不兼容", "核对 KH 点位类型，按测量值选择 DOUBLE 或 FLOAT，累计量选择 INT，状态量按实际选择 BOOL 或 INT"),
        ("保存映射提示点位被占用", "同一 KH 点位只能绑定一个设备字段；找到已有绑定并更换正确点位"),
        ("KH 测试连接失败", "检查 FDBServer REST 端口、服务状态、用户名密码、clientName 和服务器间网络"),
        ("KH 点位数量与服务器不一致", "确认 FDBServer 连接的是同一台 KH Server；重新注册客户端并同步；核对 FDBServer 可枚举范围"),
        ("日志出现校验值不匹配", "在严格校验前先保留记录警告；收集实际报文，确认算法为 XOR8、SUM8 或 LRC8 以及计算范围"),
        ("设备断连或长时间无数据", "根据设备最后接收时间和上报周期检查现场供电、通信网络、SIM 卡和目标服务器配置"),
        ("授权到期后不再写入", "申请续期并导入新激活码；确认授权恢复有效后观察日志和 KH 数据，暂停队列会继续处理"),
    ], widths=[2.05, 4.5])

    heading(doc, "7.1 提交问题时需要的信息", 2)
    add_body(doc, "需要技术人员协助时，请提供以下信息。管理后台已支持日志检索，无需导出全部数据库。")
    add_bullets(doc, [
        "问题发生的准确时间和现场操作步骤。",
        "设备名称、STC 和最后接收时间。",
        "日志页面中的完整消息、设备 ID、帧 ID 或批次 ID。",
        "软件授权状态和剩余天数，不要发送私钥或管理员密码。",
        "FDBServer 地址中的 IP 和端口，可隐藏密码。",
        "KH 点位全名、写入类型和预期值。",
        "status.cmd 显示的服务状态；启动失败时附 logs.cmd 中的错误。",
    ])

    add_section_break(doc)

    heading(doc, "8 数据保留和安全注意事项")
    add_bullets(doc, [
        "未配置设备以及未配置有效映射的设备不会保存原始报文，避免无效数据持续占用磁盘。",
        "已启用并完成映射的设备先把报文和 KH 写入任务保存到 SQLite，再由后台异步写入 KH。",
        "KH 写入失败的任务会自动快速重试，超过快速重试次数后转为低频持续重试，不会因一次网络异常直接丢弃。",
        "正常成功数据默认保留 30 天，失败历史和后台异常日志默认保留 90 天；仍在等待写入的任务不会被保留期清理。",
        "文件日志只记录警告和错误。日志文件达到约 20 MB 后自动轮转，轮转文件默认保留 30 天。",
        "不要在服务运行时修改 data-relay.db，不要手工删除 SQLite 的 wal 或 shm 文件。",
        "管理员密码、KH 密码、激活文件和备份应限制访问权限。激活码生成工具和签名私钥不得放入客户服务器。",
    ])

    heading(doc, "8.1 正式投运确认", 2)
    add_table(doc, ["确认项", "结果"], [
        ("管理员默认密码已修改", "□"),
        ("软件授权有效，设备上限和到期时间正确", "□"),
        ("设备目标 IP 和 TCP 端口配置正确", "□"),
        ("LEN 和校验策略已按现场报文确认", "□"),
        ("FDBServer 注册、测试和点位同步成功", "□"),
        ("每台设备只启用需要存储的字段", "□"),
        ("KH 点位没有重复绑定，写入类型兼容", "□"),
        ("至少连续观察两个上报周期，最后接收时间正常", "□"),
        ("KH 中的值、采集时间和点位均正确", "□"),
        ("设备断连和 KH 异常能够在日志页面查到", "□"),
        ("PM2 开机启动已经验证", "□"),
        ("data、.env 和 config 已完成首次备份", "□"),
    ], widths=[5.75, 0.8], center_columns=[1])

    heading(doc, "8.2 关键术语", 2)
    add_table(doc, ["术语", "说明"], [
        ("STC", "设备站号，Data Relay 用它识别不同设备"),
        ("FDBServer", "向 Data Relay 提供 REST API，并与 KH Server 通信的服务"),
        ("KH 点位", "KingHistorian 中保存某一项历史数据的完整变量名称"),
        ("字段映射", "把报文字段与 KH 点位建立一对一关系"),
        ("写入类型", "调用 KH 写入接口时提交的数据类型，不等同于 KH 建点类型编号"),
        ("倍率和偏移", "写入 KH 前对原始数值执行的换算参数"),
        ("TCP Keepalive", "操作系统用于探测失效 TCP 连接的机制，不是业务心跳"),
        ("PM2", "随交付包提供的 Node.js 进程管理程序，负责启动、停止和异常重启"),
    ], widths=[1.45, 5.1])

    final = doc.add_paragraph()
    final.alignment = WD_ALIGN_PARAGRAPH.CENTER
    final.paragraph_format.space_before = Pt(18)
    final_run = final.add_run("文档结束")
    set_run_font(final_run, size=10, color=MID_GRAY)

    doc.core_properties.title = "Data Relay 数据转存系统安装后使用说明"
    doc.core_properties.subject = "Data Relay 安装完成后的操作和故障排查"
    doc.core_properties.author = "Data Relay 项目组"
    doc.core_properties.keywords = "Data Relay TCP KingHistorian FDBServer 使用说明"
    doc.save(OUTPUT)
    embed_font(OUTPUT, ROOT / "assets" / "fonts" / "NotoSansCJKsc-Regular.otf", FONT_CN)
    print(OUTPUT)


if __name__ == "__main__":
    build_document()
